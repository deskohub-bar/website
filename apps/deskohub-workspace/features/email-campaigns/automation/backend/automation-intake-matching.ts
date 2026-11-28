import "server-only";

import type { DotyposCustomerId } from "@deskohub/dotypos";
import type {
  ReservationPayment,
  ReservationStay,
} from "@deskohub/workspace-admin-api";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect, Option } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import {
  emailCampaignAutomations as automations,
  customerEvents,
  emailCampaigns,
  workspaceReservations,
} from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type {
  CustomerEventId,
  CustomerEventKind,
} from "@/shared/backend/customer-events/customer-event";
import { canonicalJson } from "@/shared/utils/canonical-json";
import { reservationPaymentCondition } from "../../backend/reservation-payment-condition";
import { reservationProductCondition } from "../../backend/reservation-product-condition";
import type { CampaignId } from "../../campaign-identifiers";
import type { AutomationVersionId } from "../automation-identifiers";
import { automationTriggerKind } from "../automation-triggers";
import {
  type AutomationVersionActivation,
  versionInForce,
} from "../automation-versions";
import { takenReceiptKeys } from "./automation-run-entry";
import {
  stayTierCondition,
  triggerPayment,
  triggerStay,
} from "./automation-trigger-qualification";
import { triggeringCustomerEvent } from "./automation-triggering-events";

import { loadAutomationVersionActivations } from "./automation-version-activations";

/** A recorded customer event as intake reads it. */
export type IntakeEvent = {
  readonly id: CustomerEventId;
  readonly kind: CustomerEventKind;
  readonly occurredAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly workspaceReservationId: WorkspaceReservationId | null;
  readonly customerAccountId: CustomerAccountId | null;
  /** False for an event no automation takes in (`triggeringCustomerEvent`). */
  readonly triggering: boolean;
};

/** The columns `IntakeEvent` reads. */
export const intakeEventColumns = {
  id: customerEvents.id,
  kind: customerEvents.kind,
  occurredAt: customerEvents.occurredAt,
  recordedAt: customerEvents.recordedAt,
  dotyposCustomerId: customerEvents.dotyposCustomerId,
  workspaceReservationId: customerEvents.workspaceReservationId,
  customerAccountId: customerEvents.customerAccountId,
  triggering: triggeringCustomerEvent,
};

/** One event an automation's version in force at its occurrence takes. */
export type IntakeMatch = {
  readonly event: IntakeEvent;
  readonly campaignId: CampaignId;
  readonly versionId: AutomationVersionId;
  /** The receipt key: at most one receipt per reservation or account (D31.7). */
  readonly dedupKey: string;
  /**
   * The stay the triggering visit must be of (D1), which intake judges
   * from the live visit; none when the trigger sets none.
   */
  readonly stay: Option.Option<ReservationStay>;
};

/** An automation accepting events, with every version it published. */
type AcceptingAutomation = {
  readonly campaignId: CampaignId;
  readonly acceptingSince: Temporal.Instant;
  readonly versions: readonly AutomationVersionActivation[];
};

/**
 * The receipt key of an event: one per reservation and kind, or per
 * account, across versions (§1.2.7).
 */
const intakeDedupKey = (event: IntakeEvent) =>
  `${event.kind}:${event.workspaceReservationId ?? event.customerAccountId ?? event.id}`;

/**
 * Matches events to the active automations that take them (§5.6): the
 * event can trigger at all (D37), the version in force at the occurrence
 * has a trigger of the event's kind, the event occurred at or after
 * `accepting_since` (D21, D12), the receipt key is free, and the trigger's
 * product filter (D27), payment and stored tier for its stay (D1) hold on
 * the Workspace reservation. The stay itself needs the live visit; intake
 * judges it.
 * Reads only; the caller's transaction gives it one snapshot.
 */
export const matchIntakeEvents = Effect.fn("automationIntake.match")(function* (
  events: readonly IntakeEvent[]
) {
  if (events.length === 0) return [];
  const accepting = yield* acceptingAutomations();
  const triggering = events.filter((event) => event.triggering);

  const candidates = accepting.flatMap((automation) =>
    triggering.flatMap((event) =>
      Option.match(versionInForce(automation.versions, event.occurredAt), {
        onNone: () => [],
        onSome: (version) =>
          automationTriggerKind(version.trigger) === event.kind &&
          Temporal.Instant.compare(
            event.occurredAt,
            automation.acceptingSince
          ) >= 0
            ? [{ event, automation, version }]
            : [],
      })
    )
  );

  const qualifiedReservations = yield* reservationsQualifying(
    candidates.flatMap(({ event, version }) =>
      Option.match(reservationQualifiers(version.trigger), {
        onNone: () => [],
        onSome: (qualifiers) =>
          event.workspaceReservationId === null
            ? []
            : [{ qualifiers, reservationId: event.workspaceReservationId }],
      })
    )
  );
  const reservationQualifies = (candidate: (typeof candidates)[number]) =>
    Option.match(reservationQualifiers(candidate.version.trigger), {
      onNone: () => true,
      onSome: (qualifiers) => {
        const reservationId = candidate.event.workspaceReservationId;
        return (
          reservationId !== null &&
          qualifiedReservations.has(qualifierKey(qualifiers, reservationId))
        );
      },
    });

  const matches = candidates.filter(reservationQualifies).map(
    ({ event, automation, version }): IntakeMatch => ({
      event,
      campaignId: automation.campaignId,
      versionId: version.id,
      dedupKey: intakeDedupKey(event),
      stay: triggerStay(version.trigger),
    })
  );
  const taken = yield* Effect.forEach(
    Map.groupBy(matches, ({ campaignId }) => campaignId),
    ([campaignId, ofCampaign]) =>
      takenReceiptKeys(
        campaignId,
        ofCampaign.map(({ dedupKey }) => dedupKey)
      ).pipe(
        Effect.map((keys) => [...keys].map((key) => receiptOf(campaignId, key)))
      )
  ).pipe(Effect.map((keys) => new Set(keys.flat())));
  return matches.filter(
    ({ campaignId, dedupKey }) => !taken.has(receiptOf(campaignId, dedupKey))
  );
});

const receiptOf = (campaignId: CampaignId, dedupKey: string) =>
  `${campaignId}\u0000${dedupKey}`;

/** Active automations accepting events, each with its versions. */
const acceptingAutomations = () =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    db
      .select({
        campaignId: automations.campaignId,
        acceptingSince: automations.acceptingSince,
      })
      .from(automations)
      .innerJoin(emailCampaigns, eq(emailCampaigns.id, automations.campaignId))
      .where(
        and(
          eq(emailCampaigns.status, "active"),
          isNotNull(automations.acceptingSince)
        )
      )
      .orderBy(asc(automations.campaignId))
      .pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            // Filtered on non-null above.
            rows.flatMap(({ campaignId, acceptingSince }) =>
              acceptingSince === null ? [] : [{ campaignId, acceptingSince }]
            ),
            ({ campaignId, acceptingSince }) =>
              loadAutomationVersionActivations(campaignId).pipe(
                Effect.map(
                  (versions): AcceptingAutomation => ({
                    campaignId,
                    acceptingSince,
                    versions,
                  })
                )
              )
          )
        )
      )
  );

type ProductFilter = NonNullable<
  Extract<
    AutomationVersionActivation["trigger"],
    { readonly product?: unknown }
  >["product"]
>;

/**
 * What a reservation trigger's Workspace reservation must be, in SQL: of
 * the product, paid the way named, and of a stored tier that can give the
 * stay (the visit decides the rest at intake).
 */
type ReservationQualifiers = {
  readonly product?: ProductFilter;
  readonly payment?: ReservationPayment;
  readonly stay?: ReservationStay;
};

/** The trigger's product filter, payment and stay; none when it sets none. */
const reservationQualifiers = (
  trigger: AutomationVersionActivation["trigger"]
): Option.Option<ReservationQualifiers> => {
  const product = "product" in trigger ? trigger.product : undefined;
  const payment = Option.getOrUndefined(triggerPayment(trigger));
  const stay = Option.getOrUndefined(triggerStay(trigger));
  return product === undefined && payment === undefined && stay === undefined
    ? Option.none()
    : Option.some({
        ...(product !== undefined && { product }),
        ...(payment !== undefined && { payment }),
        ...(stay !== undefined && { stay }),
      });
};

const qualifierKey = (
  qualifiers: ReservationQualifiers,
  reservationId: WorkspaceReservationId
) => `${canonicalJson(qualifiers)}\u0000${reservationId}`;

/** The (qualifiers, reservation) pairs whose reservation meets them, in SQL. */
const reservationsQualifying = (
  pairs: readonly {
    readonly qualifiers: ReservationQualifiers;
    readonly reservationId: WorkspaceReservationId;
  }[]
) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    Effect.forEach(
      Map.groupBy(pairs, ({ qualifiers }) => canonicalJson(qualifiers)),
      ([, group]) => {
        const [first] = group;
        if (first === undefined) return Effect.succeed([]);
        const { qualifiers } = first;
        return db
          .select({ id: workspaceReservations.id })
          .from(workspaceReservations)
          .where(
            and(
              inArray(workspaceReservations.id, [
                ...new Set(group.map(({ reservationId }) => reservationId)),
              ]),
              qualifiers.product === undefined
                ? undefined
                : reservationProductCondition(qualifiers.product),
              qualifiers.payment === undefined
                ? undefined
                : reservationPaymentCondition(qualifiers.payment),
              qualifiers.stay === undefined
                ? undefined
                : stayTierCondition(qualifiers.stay)
            )
          )
          .pipe(
            Effect.map((rows) =>
              rows.map(({ id }) => qualifierKey(qualifiers, id))
            )
          );
      }
    ).pipe(Effect.map((keys) => new Set(keys.flat())))
  );
