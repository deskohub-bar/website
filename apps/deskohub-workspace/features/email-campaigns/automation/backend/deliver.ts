import {
  type DotyposCustomer,
  type DotyposCustomerId,
  DotyposService,
  dotyposIdReadRequests,
} from "@deskohub/dotypos";
import type { EmailDocument } from "@deskohub/workspace-admin-api";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  Array as Arr,
  Effect,
  Match,
  Option,
  Order,
  Result,
  Schema,
} from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  emailCampaignAutomationCustomerClaims as customerClaims,
  emailCampaignRecipients,
  emailCampaignSends,
  emailCampaignAutomationRuns as runs,
  emailCampaignAutomationWorkUnits as units,
  emailCampaignAutomationVersions as versions,
} from "@/db/schema";
import { isDatabaseQueryError } from "@/db/sql-constraint";
import type { Locale } from "@/features/i18n";
import {
  type ReservationVisit,
  ReservationVisits,
} from "@/features/reservation/backend/reservation-visits.service";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { temporalInstantToIsoString } from "@/shared/utils/temporal";
import type { RenderedCustomerEmail } from "../../backend/campaign-batch-delivery.service";
import {
  CampaignCandidateRepository,
  type OneOffCampaignEmails,
} from "../../backend/campaign-candidate.repository";
import {
  getCampaignEmailVersion,
  renderAutomatedPublishedEmail,
} from "../../backend/campaign-published-email";
import type { CampaignId, CampaignSendId } from "../../campaign-identifiers";
import {
  campaignFallbackLocale,
  resolveRecipientLocale,
} from "../../recipient-locale";
import { automationFlowSchema } from "../automation-flow";
import {
  type AutomationRunId,
  type AutomationStepId,
  type AutomationVersionId,
  type AutomationWorkUnitId,
  automationRunIdSchema,
  automationVersionIdSchema,
} from "../automation-identifiers";
import {
  deliverVerdictOf,
  oneOffCampaignGapHold,
} from "../automation-send-policies";
import type { AutomationSendDeferralCause } from "../automation-states";
import { automationTickAtOrBefore } from "../automation-ticks";
import {
  readsTriggeringVisit,
  triggeringVisitVerdict,
  type WorkspaceCancellations,
  withdrawnByWorkspaceCancellation,
} from "../automation-trigger-verification";
import { isPassReminderKind } from "../automation-triggers";
import {
  AutomatedSendSubmission,
  makeAutomatedCampaignSend,
} from "./automated-campaign-send";
import { customersAlreadySentOnce } from "./automation-customer-claims";
import { lockAutomationForEngine } from "./automation-lifecycle-lock";
import { AutomationRunSettlement } from "./automation-run-settlement.service";
import { appendAutomationRunProgress } from "./automation-run-timeline";
import {
  type AutomationRunExpectation,
  AutomationRunTransitions,
} from "./automation-run-transitions";
import { lockTriggeringReservations } from "./automation-triggering-reservations";
import {
  AutomationUnitFetchFailure,
  type AutomationUnitHandler,
  AutomationUnitRecheckFailed,
  type ClaimedAutomationUnit,
  type PlannedAutomationUnit,
  registerAutomationUnitHandler,
} from "./automation-unit-handler";
import { makePassHolderGuard } from "./pass-holder-guard";
import {
  makePassReminderDelivery,
  type PassReminderRun,
  type PreparedPassReminder,
  renderPassReminderPublishedEmail,
} from "./pass-reminder-delivery";

/** A deliver unit holds at most this many runs of one version (§1.2.13). */
export const deliverUnitRunLimit = 100;

/**
 * A deferred run is verified live again this long after the tick that
 * deferred it (§5.9), however late in that tick its unit committed.
 */
const deferredRecheck = { minutes: 15 } as const;

const deliverSubjectSchema = Schema.Struct({
  versionId: automationVersionIdSchema,
  runIds: Schema.Array(automationRunIdSchema).check(
    Schema.isMaxLength(deliverUnitRunLimit)
  ),
});
type DeliverSubject = typeof deliverSubjectSchema.Type;

/**
 * The deliver unit of send-ready runs of one version. Its key is unique per
 * planning, so runs a settled unit released are planned afresh.
 */
export const plannedDeliverUnit = (input: {
  readonly campaignId: CampaignId;
  readonly versionId: AutomationVersionId;
  readonly runIds: readonly AutomationRunId[];
  /** Triggering reservations to verify. */
  readonly reservations: number;
  readonly customers: number;
  readonly readsPassDeskLabel?: boolean;
  readonly at: Temporal.Instant;
}): PlannedAutomationUnit => ({
  kind: "deliver",
  key: `deliver:${input.versionId}:${temporalInstantToIsoString(input.at)}:${input.runIds[0]}`,
  campaignId: input.campaignId,
  subject: Schema.encodeSync(deliverSubjectSchema)({
    versionId: input.versionId,
    runIds: input.runIds,
  }),
  requestCost: deliverRequestCost(input),
});

/**
 * The unit's Dotypos requests: one reservation page per 100 triggering
 * reservations, and one profile page per 100 customers for the recheck.
 */
const deliverRequestCost = (input: {
  readonly reservations: number;
  readonly customers: number;
  readonly readsPassDeskLabel?: boolean;
}) =>
  dotyposIdReadRequests(input.reservations) +
  dotyposIdReadRequests(input.customers) +
  Number(input.readsPassDeskLabel ?? false);

/** The flow's Send step, with its delivery policies. */
type SendStep = Extract<
  (typeof automationFlowSchema.Type)["steps"][number],
  { readonly _tag: "Send" }
>;

type DeliverRun = PassReminderRun & {
  readonly id: AutomationRunId;
  readonly triggerReservationId: WorkspaceReservationId | null;
};

/** What a deliver unit read live, outside any transaction (§5.9 step 1). */
type DeliverFacts = {
  readonly campaignId: CampaignId;
  /** None when the version's flow no longer decodes or has no send. */
  readonly sendStep: Option.Option<SendStep>;
  readonly runs: readonly DeliverRun[];
  readonly visits: ReadonlyMap<
    WorkspaceReservationId,
    Option.Option<ReservationVisit>
  >;
  readonly profiles: ReadonlyMap<DotyposCustomerId, DotyposCustomer>;
  readonly locales: ReadonlyMap<DotyposCustomerId, Locale>;
  readonly passReminder: Option.Option<PreparedPassReminder>;
  readonly emailDocument: Option.Option<EmailDocument>;
};

const decodeFlow = Schema.decodeUnknownOption(automationFlowSchema);

/** A version's Send step; none when its flow no longer decodes. */
const sendStepOf = (
  version: Pick<typeof versions.$inferSelect, "flow">
): Option.Option<SendStep> =>
  Option.flatMap(decodeFlow(version.flow), (decoded) =>
    Option.fromNullishOr(
      decoded.steps.find((step): step is SendStep => step._tag === "Send")
    )
  );

/**
 * Verifies, persists, submits and settles one batch of send-ready runs in
 * one invocation (§5.9), so no batch reaches the provider on an older
 * verification. Once its commit sets the unit's `send_id`, the unit is the
 * batch's only way to settle and replays it until it does.
 */
export const makeDeliverHandler = Effect.gen(function* () {
  const { db } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;
  const candidates = yield* CampaignCandidateRepository;
  const sends = yield* makeAutomatedCampaignSend;
  const passReminders = yield* makePassReminderDelivery;
  const passHolderGuard = yield* makePassHolderGuard;
  const runSettlement = yield* AutomationRunSettlement;
  const context = yield* Effect.context<WorkspaceDatabase | DotyposService>();

  const passTrigger = {
    dotyposCustomerId: runs.dotyposCustomerId,
    triggerKind: runs.triggerKind,
    triggerAt: runs.triggerAt,
    triggerPassId: runs.triggerPassId,
    passReminderContext: runs.passReminderContext,
  };

  /** The unit's runs still open at their send step and owned by it. */
  const loadRuns = (unit: ClaimedAutomationUnit<DeliverSubject>) =>
    db
      .select({
        id: runs.id,
        ...passTrigger,
        triggerReservationId: runs.triggerReservationId,
      })
      .from(runs)
      .where(
        and(
          inArray(runs.id, [...unit.subject.runIds]),
          eq(runs.versionId, unit.subject.versionId),
          eq(runs.workUnitId, unit.id),
          eq(runs.status, "active"),
          eq(runs.phase, "ready")
        )
      )
      .orderBy(asc(runs.id));

  const loadPassReminderForSend = (sendId: CampaignSendId) =>
    db
      .select({ ...passTrigger, locale: emailCampaignRecipients.locale })
      .from(runs)
      .leftJoin(
        emailCampaignRecipients,
        and(
          eq(emailCampaignRecipients.sendId, runs.sendId),
          eq(emailCampaignRecipients.dotyposCustomerId, runs.dotyposCustomerId)
        )
      )
      .where(
        and(
          eq(runs.sendId, sendId),
          inArray(runs.triggerKind, ["entry-pack-expiring", "unlimited-ending"])
        )
      )
      .limit(1)
      .pipe(Effect.map(([run]) => Option.fromNullishOr(run)));

  /** The flow of the version an automated send pins. */
  const loadSendVersionFlow = (sendId: CampaignSendId) =>
    db
      .select({ flow: versions.flow })
      .from(emailCampaignSends)
      .innerJoin(
        versions,
        eq(versions.id, emailCampaignSends.automationVersionId)
      )
      .where(eq(emailCampaignSends.id, sendId))
      .pipe(Effect.map(([version]) => Option.fromNullishOr(version)));

  const loadVersion = (versionId: AutomationVersionId) =>
    db
      .select({
        campaignId: versions.campaignId,
        purpose: versions.purpose,
        flow: versions.flow,
        frozenEmailVersionId: versions.frozenEmailVersionId,
      })
      .from(versions)
      .where(eq(versions.id, versionId))
      .pipe(Effect.map(([version]) => Option.fromNullishOr(version)));

  const readVisits = (open: readonly DeliverRun[]) =>
    Effect.flatMap(ReservationVisits, (visits) =>
      visits.ofReservations(
        open.flatMap((run) =>
          run.triggerReservationId !== null &&
          readsTriggeringVisit(run.triggerKind)
            ? [run.triggerReservationId]
            : []
        )
      )
    ).pipe(
      Effect.provide(ReservationVisits.Default),
      Effect.provideContext(context),
      Effect.mapError(AutomationUnitFetchFailure.fromReservationVisits)
    );

  // One page at a time: a unit's requests are sequential (§5.3).
  const readProfiles = (customerIds: readonly DotyposCustomerId[]) =>
    dotypos
      .getCustomersByIds(customerIds, { concurrency: 1 })
      .pipe(Effect.mapError(AutomationUnitFetchFailure.fromDotypos));

  const fetch = (unit: ClaimedAutomationUnit<DeliverSubject>) =>
    Effect.Do.pipe(
      Effect.bind("version", () =>
        loadVersion(unit.subject.versionId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new AutomationUnitFetchFailure({ code: "version-missing" })
                ),
              onSome: Effect.succeed,
            })
          )
        )
      ),
      Effect.bind("runs", () => loadRuns(unit)),
      Effect.let("customerIds", ({ runs: open }) =>
        open.map((run) => run.dotyposCustomerId)
      ),
      Effect.bind("visits", ({ runs: open }) => readVisits(open)),
      Effect.bind("profiles", ({ customerIds }) => readProfiles(customerIds)),
      Effect.bind("locales", ({ version, customerIds }) =>
        candidates
          .listCandidates({ purpose: version.purpose, ids: customerIds })
          .pipe(
            Effect.map(
              (facts) =>
                new Map(
                  facts.map((fact) => [
                    fact.dotyposCustomerId,
                    resolveRecipientLocale(fact),
                  ])
                )
            )
          )
      ),
      Effect.bind("passReminder", ({ version, runs: [run, ...other] }) =>
        run &&
        other.length === 0 &&
        isPassReminderKind(run.triggerKind) &&
        version.purpose === "marketing"
          ? passReminders.prepare(run)
          : Effect.succeed(Option.none<PreparedPassReminder>())
      ),
      Effect.bind("emailDocument", ({ version }) =>
        version.frozenEmailVersionId === null
          ? Effect.succeed(Option.none<EmailDocument>())
          : getCampaignEmailVersion(db, version.frozenEmailVersionId).pipe(
              Effect.flatMap((loaded) =>
                loaded
                  ? Effect.succeed(Option.some(loaded.document))
                  : Effect.fail(
                      new AutomationUnitFetchFailure({
                        code: "email-version-missing",
                      })
                    )
              )
            )
      ),
      Effect.map(
        ({
          version,
          runs: open,
          visits,
          profiles,
          locales,
          passReminder,
          emailDocument,
        }): DeliverFacts => ({
          campaignId: version.campaignId,
          sendStep: sendStepOf(version),
          runs: open,
          visits,
          profiles,
          locales,
          passReminder,
          emailDocument,
        })
      ),
      Effect.catchIf(isDatabaseQueryError, (cause) =>
        Effect.fail(new AutomationUnitFetchFailure({ code: "database", cause }))
      ),
      Effect.catchTag(
        "ReleaseGateUnavailableError",
        () =>
          new AutomationUnitFetchFailure({
            code: "pass-reminder-gate-unavailable",
          })
      )
    );

  const commit = (
    unit: ClaimedAutomationUnit<DeliverSubject>,
    facts: DeliverFacts,
    at: Temporal.Instant
  ) =>
    lockAutomationForEngine(facts.campaignId).pipe(
      Effect.filterOrFail(
        (lifecycle) => lifecycle.status === "active",
        (lifecycle) =>
          new AutomationUnitRecheckFailed({
            code: `automation-${lifecycle.status ?? "missing"}`,
          })
      ),
      Effect.andThen(
        Option.match(facts.sendStep, {
          onNone: () => failUndeliverable(unit, facts, at).pipe(Effect.asVoid),
          onSome: (sendStep) =>
            persist({ unit, facts, sendStep, at }).pipe(Effect.asVoid),
        })
      ),
      Effect.as<ReadonlyArray<PlannedAutomationUnit>>([])
    );

  /** A flow that no longer decodes can't send: its runs end failed. */
  const failUndeliverable = (
    unit: ClaimedAutomationUnit<DeliverSubject>,
    facts: DeliverFacts,
    at: Temporal.Instant
  ) =>
    AutomationRunTransitions.end({
      runIds: facts.runs.map((run) => run.id),
      expect: { status: "active", phase: "ready", workUnitId: unit.id },
      outcome: "failed",
      reason: "evaluation-unavailable",
      at,
    });

  /**
   * §5.9 step 2: under the lifecycle lock and the triggering reservations'
   * share locks, row-locks the unit's runs still ready in id order (§5.4)
   * before any write, so a reclaimed worker committing the same unit takes
   * them in the same order. It judges each locked run (`deliverVerdictOf`):
   * ends withdrawn runs
   * and, for a once-per-customer send, runs whose customer the campaign
   * already sent its email (`customersAlreadySentOnce`), defers runs whose
   * trigger moved later or whom the one-off campaign gap holds, and
   * persists the rest as one send with batch 0, recording the send on the
   * unit. The policies are judged afresh at every commit, never from a
   * deferral's stored due time.
   */
  const persist = (input: {
    readonly unit: ClaimedAutomationUnit<DeliverSubject>;
    readonly facts: DeliverFacts;
    readonly sendStep: SendStep;
    readonly at: Temporal.Instant;
  }) => {
    const { sendStep } = input;
    const sendStepId = sendStep.id;
    const expect = {
      status: "active",
      stepId: sendStepId,
      phase: "ready",
      workUnitId: input.unit.id,
    } as const;
    const customers = input.facts.runs.map((run) => run.dotyposCustomerId);
    const triggerRecheckAt = automationTickAtOrBefore(input.at).add(
      deferredRecheck
    );
    return Effect.Do.pipe(
      Effect.bind("cancellations", () =>
        lockTriggeringReservations(
          input.facts.runs.map((run) => run.triggerReservationId)
        )
      ),
      Effect.bind("ready", () =>
        db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              inArray(
                runs.id,
                input.facts.runs.map((run) => run.id)
              ),
              eq(runs.status, expect.status),
              eq(runs.stepId, expect.stepId),
              eq(runs.phase, expect.phase),
              eq(runs.workUnitId, expect.workUnitId)
            )
          )
          .orderBy(asc(runs.id))
          .for("update")
          .pipe(Effect.map((locked) => new Set(locked.map(({ id }) => id))))
      ),
      Effect.bind("alreadySent", () =>
        sendStep.oncePerCustomer
          ? customersAlreadySentOnce(db, input.facts.campaignId, customers)
          : Effect.succeed(new Set<DotyposCustomerId>())
      ),
      Effect.bind("oneOffEmails", () =>
        sendStep.oneOffCampaignGap
          ? candidates.latestOneOffCampaignEmails({ customers, now: input.at })
          : Effect.succeed(new Map<DotyposCustomerId, OneOffCampaignEmails>())
      ),
      Effect.let(
        "verdicts",
        ({ ready, cancellations, alreadySent, oneOffEmails }) =>
          Arr.groupBy(
            input.facts.runs
              .flatMap((run) => (ready.has(run.id) ? [run] : []))
              .map((run) => ({
                run,
                verdict: deliverVerdictOf({
                  trigger: triggerVerdictOf({
                    run,
                    facts: input.facts,
                    cancellations,
                    at: input.at,
                  }),
                  alreadySentOnce: alreadySent.has(run.dotyposCustomerId),
                  gapHold: Option.flatMap(
                    Option.fromNullishOr(sendStep.oneOffCampaignGap),
                    (gap) =>
                      oneOffCampaignGapHold({
                        emails: oneOffEmails.get(run.dotyposCustomerId),
                        gap,
                        at: input.at,
                        inFlightRecheckAt: triggerRecheckAt,
                      })
                  ),
                  triggerRecheckAt,
                }),
              })),
            ({ verdict }) => verdict._tag
          )
      ),
      Effect.tap(({ verdicts }) =>
        AutomationRunTransitions.end({
          runIds: (verdicts.Withdraw ?? []).map(({ run }) => run.id),
          expect,
          outcome: "withdrawn",
          at: input.at,
        }).pipe(Effect.when(Effect.succeed(verdicts.Withdraw !== undefined)))
      ),
      Effect.tap(({ verdicts }) =>
        Effect.forEach(
          Object.values(
            Arr.groupBy(
              (verdicts.Skip ?? []).flatMap(({ run, verdict }) =>
                verdict._tag === "Skip" ? [{ run, reason: verdict.reason }] : []
              ),
              ({ reason }) => reason
            )
          ),
          (skipped) =>
            AutomationRunTransitions.end({
              runIds: skipped.map(({ run }) => run.id),
              expect,
              outcome: "skipped",
              reason: skipped[0].reason,
              at: input.at,
            }),
          { discard: true }
        )
      ),
      Effect.tap(({ verdicts }) =>
        defer({
          ...input,
          sendStepId,
          deferred: (verdicts.Defer ?? []).flatMap(({ run, verdict }) =>
            verdict._tag === "Defer" ? [{ run, ...verdict }] : []
          ),
        })
      ),
      Effect.tap(({ verdicts }) =>
        persistSend({
          ...input,
          sendStepId,
          expect,
          sendable: (verdicts.Send ?? []).map(({ run }) => run),
        }).pipe(Effect.when(Effect.succeed(verdicts.Send !== undefined)))
      )
    );
  };

  /**
   * Stores deferred runs `waiting` at the Send step until their recheck,
   * with the cause on their timeline. Runs deferred together share one
   * statement per recheck and cause.
   */
  const defer = (input: {
    readonly unit: ClaimedAutomationUnit<DeliverSubject>;
    readonly sendStepId: AutomationStepId;
    readonly deferred: readonly {
      readonly run: DeliverRun;
      readonly recheckAt: Temporal.Instant;
      readonly cause: AutomationSendDeferralCause;
    }[];
    readonly at: Temporal.Instant;
  }) =>
    Effect.forEach(
      Object.values(
        Arr.groupBy(
          input.deferred,
          ({ recheckAt, cause }) =>
            `${cause}:${temporalInstantToIsoString(recheckAt)}`
        )
      ),
      (group) => {
        const { recheckAt, cause } = group[0];
        return db
          .update(runs)
          .set({
            phase: "waiting",
            dueAt: recheckAt,
            workUnitId: null,
            updatedAt: input.at,
          })
          .where(
            and(
              inArray(
                runs.id,
                group.map(({ run }) => run.id)
              ),
              eq(runs.status, "active"),
              eq(runs.stepId, input.sendStepId),
              eq(runs.phase, "ready"),
              eq(runs.workUnitId, input.unit.id)
            )
          )
          .returning({ id: runs.id })
          .pipe(
            Effect.flatMap((deferred) =>
              appendAutomationRunProgress(
                deferred.map(({ id }) => ({
                  runId: id,
                  kind: "deferred" as const,
                  stepId: input.sendStepId,
                  at: input.at,
                  detail: {
                    cause,
                    recheckAt: temporalInstantToIsoString(recheckAt),
                  },
                }))
              ).pipe(Effect.when(Effect.succeed(deferred.length > 0)))
            )
          );
      },
      { discard: true }
    );

  /**
   * The customers' claims (D2), for sendable runs the commit already
   * row-locked, in customer order. Every send claims, so the claim insert
   * arbitrates between any two runs of the campaign committing at once,
   * whatever their versions' policies: a once-per-customer send goes on
   * only with the runs that won their claim, and a run whose customer
   * another run claimed since the verdict ends `skipped / already-sent-once`.
   * Without the policy every sendable run goes on, claim won or not.
   * Earlier runs are settled by the verdict's read, which sees them
   * committed: a campaign holds one open run per customer, so a run exists
   * only once the customer's earlier run ended. Pass reminders, exempt from
   * that, meet their concurrent runs here.
   */
  const claimCustomers = Effect.fn("DeliverUnit.claimCustomers")(
    function* (input: {
      readonly facts: DeliverFacts;
      readonly sendStep: SendStep;
      readonly expect: AutomationRunExpectation;
      readonly sendable: readonly DeliverRun[];
      readonly at: Temporal.Instant;
    }) {
      if (input.sendable.length === 0) return [];
      const claimed = yield* db
        .insert(customerClaims)
        .values(
          Arr.sort(
            input.sendable.map((run) => ({
              campaignId: input.facts.campaignId,
              dotyposCustomerId: run.dotyposCustomerId,
              runId: run.id,
              claimedAt: input.at,
            })),
            claimOrder
          )
        )
        .onConflictDoNothing({
          target: [customerClaims.campaignId, customerClaims.dotyposCustomerId],
        })
        .returning({ runId: customerClaims.runId });
      if (!input.sendStep.oncePerCustomer) return input.sendable;
      const won = new Set(claimed.map(({ runId }) => runId));
      const winners = input.sendable.filter((run) => won.has(run.id));
      const losers = input.sendable.filter((run) => !won.has(run.id));
      if (losers.length > 0) {
        yield* AutomationRunTransitions.end({
          runIds: losers.map((run) => run.id),
          expect: input.expect,
          outcome: "skipped",
          reason: "already-sent-once",
          at: input.at,
        });
      }
      return winners;
    }
  );

  /**
   * Creates the send, moves the runs to `sending` and freezes their
   * recipients from the runs that moved, then persists batch 0 and records
   * the send on the unit, all before any request.
   */
  const persistSend = (input: {
    readonly unit: ClaimedAutomationUnit<DeliverSubject>;
    readonly facts: DeliverFacts;
    readonly sendStep: SendStep;
    readonly sendStepId: AutomationStepId;
    readonly expect: AutomationRunExpectation;
    readonly sendable: readonly DeliverRun[];
    readonly at: Temporal.Instant;
  }) =>
    claimCustomers(input).pipe(
      Effect.flatMap((claimed) =>
        claimed.length === 0
          ? Effect.void
          : createSend({ ...input, sendable: claimed })
      )
    );

  const createSend = (input: {
    readonly unit: ClaimedAutomationUnit<DeliverSubject>;
    readonly facts: DeliverFacts;
    readonly sendStep: SendStep;
    readonly sendStepId: AutomationStepId;
    readonly sendable: readonly DeliverRun[];
    readonly at: Temporal.Instant;
  }) =>
    sends
      .create({
        campaignId: input.facts.campaignId,
        versionId: input.unit.subject.versionId,
        at: input.at,
      })
      .pipe(
        Effect.bindTo("sendId"),
        Effect.bind("sending", ({ sendId }) =>
          db
            .update(runs)
            .set({
              status: "sending",
              phase: null,
              dueAt: null,
              sendId,
              updatedAt: input.at,
              ...Option.match(input.facts.passReminder, {
                onNone: () => ({}),
                onSome: ({ snapshot }) => ({ passReminderContext: snapshot }),
              }),
            })
            .where(
              and(
                inArray(
                  runs.id,
                  input.sendable.map((run) => run.id)
                ),
                eq(runs.status, "active"),
                eq(runs.stepId, input.sendStepId),
                eq(runs.phase, "ready"),
                eq(runs.workUnitId, input.unit.id)
              )
            )
            .returning({
              id: runs.id,
              dotyposCustomerId: runs.dotyposCustomerId,
            })
        ),
        Effect.tap(({ sendId, sending }) => {
          if (sending.length === 0) {
            // A commit about to lose its claim can leave an empty send.
            return db
              .delete(emailCampaignSends)
              .where(eq(emailCampaignSends.id, sendId));
          }
          const recipients = sending.map(({ dotyposCustomerId }) => ({
            dotyposCustomerId,
            locale:
              input.facts.locales.get(dotyposCustomerId) ??
              campaignFallbackLocale,
          }));
          const guarded =
            Option.isSome(input.facts.passReminder) ||
            input.sendStep.skipPassHolders === true;
          let renderedByCustomer:
            | Map<DotyposCustomerId, RenderedCustomerEmail>
            | undefined;
          if (Option.isSome(input.facts.emailDocument)) {
            renderedByCustomer = new Map();
            const document = input.facts.emailDocument.value;
            for (const recipient of recipients) {
              const rendered = Option.isSome(input.facts.passReminder)
                ? renderPassReminderPublishedEmail({
                    document,
                    reminder: input.facts.passReminder.value,
                    locale: recipient.locale,
                    profile: input.facts.profiles.get(
                      recipient.dotyposCustomerId
                    ),
                  })
                : renderAutomatedPublishedEmail({
                    document,
                    recipientLocale: recipient.locale,
                  });
              if (Result.isSuccess(rendered)) {
                renderedByCustomer.set(
                  recipient.dotyposCustomerId,
                  rendered.success
                );
              }
            }
          }
          return sends
            .persistBatch({
              sendId,
              recipients,
              profiles: input.facts.profiles,
              at: input.at,
              ...(renderedByCustomer && { renderedByCustomer }),
              ...(guarded && { guarded: true as const }),
            })
            .pipe(
              Effect.andThen(
                appendAutomationRunProgress(
                  sending.map(({ id }) => ({
                    runId: id,
                    kind: "send-queued" as const,
                    stepId: input.sendStepId,
                    at: input.at,
                    detail: { sendId },
                  }))
                )
              ),
              Effect.andThen(recordUnitSend({ unitId: input.unit.id, sendId }))
            );
        })
      );

  const recordUnitSend = (input: {
    readonly unitId: AutomationWorkUnitId;
    readonly sendId: CampaignSendId;
  }) =>
    db
      .update(units)
      .set({ sendId: input.sendId })
      .where(and(eq(units.id, input.unitId), isNull(units.sendId)));

  /**
   * §5.9 step 4: records the submitted send's batch outcomes, completes the
   * send and ends its runs from their recipients. A send an earlier
   * settlement completed already ended its runs, so nothing is left.
   */
  const settleSubmission = (input: {
    readonly sendId: CampaignSendId;
    readonly submission: AutomatedSendSubmission;
    readonly at: Temporal.Instant;
  }) =>
    AutomatedSendSubmission.$match(input.submission, {
      AlreadyCompleted: () => Effect.void,
      Submitted: ({ batches }) =>
        sends
          .settle({ sendId: input.sendId, batches, at: input.at })
          .pipe(
            Effect.andThen(
              runSettlement.settle({ sendId: input.sendId, at: input.at })
            )
          ),
    });

  const handler: AutomationUnitHandler<DeliverSubject, DeliverFacts> = {
    kind: "deliver",
    subject: deliverSubjectSchema,
    fetch,
    commit,
    submit: (unit, facts) =>
      Effect.all([
        loadPassReminderForSend(unit.sendId),
        loadSendVersionFlow(unit.sendId),
      ]).pipe(
        Effect.flatMap(([pass, version]) => {
          const profiles = Option.map(facts, ({ profiles }) => profiles);
          const claim = { unitId: unit.id, claimId: unit.claimId };
          // A redelivered unit rebuilds the guard from the version the send
          // pins, as the first request had it.
          const skipsPassHolders = Option.exists(
            Option.flatMap(version, sendStepOf),
            (step) => step.skipPassHolders === true
          );
          const requestGuarded = Option.match(pass, {
            onSome: (run) => passReminders.request({ run, profiles, claim }),
            onNone: () =>
              skipsPassHolders
                ? passHolderGuard.request({ profiles, claim })
                : undefined,
          });
          return sends.submit({
            sendId: unit.sendId,
            profiles,
            ...(requestGuarded && { requestGuarded }),
          });
        }),
        Effect.map(
          (submission) => (at: Temporal.Instant) =>
            // Serialises the settlement with archive (§5.4).
            Effect.forEach(
              Option.toArray(Option.fromNullishOr(unit.campaignId)),
              (campaignId) => lockAutomationForEngine(campaignId)
            ).pipe(
              Effect.andThen(
                settleSubmission({ sendId: unit.sendId, submission, at })
              )
            )
        ),
        Effect.catchTag("CampaignDeliveryIncomplete", (cause) =>
          Effect.fail(
            new AutomationUnitFetchFailure({
              code: "delivery-incomplete",
              cause,
            })
          )
        )
      ),
  };

  return registerAutomationUnitHandler(handler);
});

/**
 * What the pre-submit check (§5.9) makes of one run at the send instant:
 * `send`, `withdraw` because its reservation was cancelled or is gone, or
 * because a restore undid the cancellation that triggered it (D28), or
 * `defer` because Dotypos moved its visit so the trigger hasn't happened
 * yet.
 */
const triggerVerdictOf = (input: {
  readonly run: DeliverRun;
  readonly facts: DeliverFacts;
  readonly cancellations: WorkspaceCancellations;
  readonly at: Temporal.Instant;
}): "send" | "withdraw" | "defer" => {
  const { run } = input;
  if (isPassReminderKind(run.triggerKind)) {
    return Option.isSome(input.facts.passReminder) ? "send" : "withdraw";
  }
  const reservation = run.triggerReservationId;
  if (reservation === null) return "send";
  if (
    withdrawnByWorkspaceCancellation(
      { kind: run.triggerKind, at: run.triggerAt, reservationId: reservation },
      input.cancellations
    )
  ) {
    return "withdraw";
  }
  return Match.value(
    triggeringVisitVerdict({
      kind: run.triggerKind,
      visit: Option.flatten(
        Option.fromNullishOr(input.facts.visits.get(reservation))
      ),
      asOf: input.at,
    })
  ).pipe(
    Match.when("current", () => "send" as const),
    Match.when("withdrawn", () => "withdraw" as const),
    Match.when("moved", () => "defer" as const),
    Match.exhaustive
  );
};

/** Claims go in customer order, so concurrent claimers can't deadlock. */
const claimOrder = Order.mapInput(
  Order.String,
  (claim: { readonly dotyposCustomerId: DotyposCustomerId }) =>
    claim.dotyposCustomerId
);
