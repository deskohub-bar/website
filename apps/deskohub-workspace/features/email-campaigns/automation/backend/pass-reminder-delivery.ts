import "server-only";

import {
  type DotyposCustomer,
  type DotyposCustomerId,
  DotyposService,
} from "@deskohub/dotypos";
import type {
  EmailDocument,
  EmailVersionId,
} from "@deskohub/workspace-admin-api";
import { Effect, Option, Result, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import type { PassReminderTriggerPayload } from "@/features/emails/body/pass-reminder-trigger-values";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import {
  type PassReminderCandidate,
  PassReminderReads,
} from "@/features/passes/backend/pass-reminder-reads.service";
import {
  getEntryPackBookingPath,
  getUnlimitedRenewalPath,
} from "@/features/passes/routes";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { getWorkspaceCanonicalUrl } from "@/shared/utils/site-constants";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  type BatchProfiles,
  BatchRequest,
  type BatchRequestClaim,
  type BatchRequestGuard,
  CampaignBatchDelivery,
  CampaignDeliveryIncomplete,
  type DeliveredAttempt,
  type PersistedBatch,
  type RenderedCustomerEmail,
} from "../../backend/campaign-batch-delivery.service";
import { CampaignEmailConfig } from "../../backend/campaign-email.config";
import {
  getCampaignEmailVersion,
  renderAutomatedPublishedEmail,
  resolveEmailDocumentLocale,
} from "../../backend/campaign-published-email";
import {
  CampaignEligibilityStage,
  campaignEligibility,
  consentingCampaignCustomers,
} from "../../backend/campaign-reachability";
import type { AutomationTriggerKind } from "../automation-states";
import {
  type PassReminderContext,
  passReminderContext,
} from "../pass-reminder-context";

export type PassReminderRun = {
  readonly triggerKind: AutomationTriggerKind;
  readonly triggerAt: Temporal.Instant;
  readonly triggerPassId: OrderId | null;
  readonly passReminderContext: PassReminderContext | null;
  readonly dotyposCustomerId: DotyposCustomerId;
};

export type PreparedPassReminder = {
  readonly passId: OrderId;
  readonly snapshot: PassReminderContext;
};

export const passReminderWithdrawnCode = "pass-reminder-withdrawn";
const decodePassReminderContext =
  Schema.decodeUnknownOption(passReminderContext);

const snapshotOf = (candidate: PassReminderCandidate): PassReminderContext => {
  const common = {
    copyVersion: 1,
    holderAccountId: candidate.holderAccountId,
    holderVersion: candidate.holderVersion,
    tier: candidate.tier,
    endsOn: candidate.lastUsableDate,
  } as const;
  return candidate.kind === "entry-pack"
    ? {
        ...common,
        product: candidate.kind,
        remainingEntries: candidate.entriesLeft,
        totalEntries: candidate.packSize,
      }
    : {
        ...common,
        product: candidate.kind,
        renewalStartsOn: candidate.nextPeriodStart,
        ...(candidate.deskLabel && { deskLabel: candidate.deskLabel }),
      };
};

const decodeCurrentSnapshot = (candidate: PassReminderCandidate) => {
  const snapshot = snapshotOf(candidate);
  if (snapshot.product === "entry-pack") {
    return decodePassReminderContext(snapshot);
  }
  const { deskLabel, ...withoutDeskLabel } = snapshot;
  return Option.orElse(decodePassReminderContext(snapshot), () =>
    decodePassReminderContext(withoutDeskLabel)
  );
};

const firstNameOf = (profile: DotyposCustomer | undefined) =>
  profile?.firstName?.trim() || undefined;

const passReminderTriggerPayload = (input: {
  readonly reminder: PreparedPassReminder;
  readonly locale: Locale;
  readonly profile: DotyposCustomer | undefined;
}): PassReminderTriggerPayload => {
  const { passId, snapshot } = input.reminder;
  const firstName = firstNameOf(input.profile);
  const path =
    snapshot.product === "entry-pack"
      ? getEntryPackBookingPath(input.locale, passId)
      : getUnlimitedRenewalPath(input.locale, passId);
  const actionUrl = getWorkspaceCanonicalUrl(path);
  return snapshot.product === "entry-pack"
    ? {
        trigger: "entry-pack-expiring",
        firstName,
        tier: snapshot.tier,
        endsOn: snapshot.endsOn,
        remainingEntries: snapshot.remainingEntries,
        totalEntries: snapshot.totalEntries,
        actionUrl,
      }
    : {
        trigger: "unlimited-ending",
        firstName,
        tier: snapshot.tier,
        endsOn: snapshot.endsOn,
        renewalStartsOn: snapshot.renewalStartsOn,
        deskLabel: snapshot.deskLabel,
        actionUrl,
      };
};

/** Renders a pass reminder's published Email Library document for one recipient. */
export const renderPassReminderPublishedEmail = (input: {
  readonly document: EmailDocument;
  readonly reminder: PreparedPassReminder;
  readonly locale: Locale;
  readonly profile: DotyposCustomer | undefined;
}): Result.Result<RenderedCustomerEmail, string> => {
  const contentLocale = resolveEmailDocumentLocale(
    input.document,
    input.locale
  );
  return renderAutomatedPublishedEmail({
    document: input.document,
    recipientLocale: contentLocale,
    triggerPayload: passReminderTriggerPayload({
      reminder: input.reminder,
      locale: contentLocale,
      profile: input.profile,
    }),
  });
};

export const makePassReminderDelivery = Effect.gen(function* () {
  const { db } = yield* WorkspaceDatabase;
  const dotypos = yield* DotyposService;
  const passes = yield* PassReminderReads;
  const gate = yield* CoworkPassesReleaseGate;
  const config = yield* CampaignEmailConfig;
  const batches = yield* CampaignBatchDelivery;

  const readCurrent = Effect.fn("PassReminderDelivery.readCurrent")(function* (
    run: PassReminderRun,
    includeDeskLabel?: true
  ) {
    const context = decodePassReminderContext(run.passReminderContext);
    if (
      run.triggerPassId === null ||
      Option.isNone(context) ||
      (context.value.product === "entry-pack"
        ? run.triggerKind !== "entry-pack-expiring"
        : run.triggerKind !== "unlimited-ending") ||
      !(yield* gate.decision)
    ) {
      return Option.none<PassReminderCandidate>();
    }

    const now = yield* currentInstant;
    const candidate = yield* passes.readDue({
      kind: context.value.product,
      dueDate: plainDateStringSchema.make(
        getWorkspaceDate(run.triggerAt).toString()
      ),
      now,
      passId: run.triggerPassId,
      holderAccountId: context.value.holderAccountId,
      holderVersion: context.value.holderVersion,
      ...(includeDeskLabel && { includeDeskLabel }),
    });
    return Option.filter(
      candidate,
      ({ dotyposCustomerId }) => dotyposCustomerId === run.dotyposCustomerId
    );
  });

  const prepare = (run: PassReminderRun) =>
    readCurrent(run, true).pipe(
      Effect.map(
        Option.flatMap((candidate) =>
          Option.map(
            decodeCurrentSnapshot(candidate),
            (snapshot): PreparedPassReminder => ({
              passId: candidate.passId,
              snapshot,
            })
          )
        )
      )
    );

  const profilesFor = (batch: PersistedBatch) =>
    dotypos
      .getCustomersByIds(batch.dotyposCustomerIds, { concurrency: 1 })
      .pipe(Effect.mapError(() => incompleteRequest(batch)));

  const guard = (input: {
    readonly run: PassReminderRun;
    readonly batch: PersistedBatch;
    readonly profiles: BatchProfiles;
  }): BatchRequestGuard =>
    Effect.gen(function* () {
      const withdrawn = { failureCode: passReminderWithdrawnCode };
      const id = input.run.dotyposCustomerId;
      const expected = input.profiles.get(id);
      const profiles = yield* profilesFor(input.batch);
      const candidate = yield* readCurrent(input.run).pipe(
        Effect.catchTag("ReleaseGateUnavailableError", () =>
          incompleteRequest(input.batch)
        )
      );
      if (Option.isNone(candidate)) return withdrawn;
      const consenting = yield* consentingCampaignCustomers({
        db,
        purpose: "marketing",
        customerIds: [id],
      });
      const profile = profiles.get(id);
      const reachable = campaignEligibility({
        profile: Option.fromNullishOr(profile),
        stage: CampaignEligibilityStage.Delivery({
          consenting: consenting.has(id),
          deploymentEnvironment: config.deploymentEnvironment,
        }),
      });
      if (Result.isFailure(reachable)) return { skipReason: reachable.failure };

      const original = campaignEligibility({
        profile: Option.fromNullishOr(expected),
        stage: CampaignEligibilityStage.Resolution(),
      });
      if (
        Result.isFailure(original) ||
        original.success !== reachable.success ||
        firstNameOf(expected) !== firstNameOf(profile)
      )
        return withdrawn;

      return true as const;
    });

  const request =
    (input: {
      readonly run: PassReminderRun & { readonly locale: Locale | null };
      readonly profiles: Option.Option<BatchProfiles>;
      readonly claim: BatchRequestClaim;
    }) =>
    (
      send: DeliveredAttempt,
      batch: PersistedBatch,
      frozenEmailVersionId: EmailVersionId | null
    ) =>
      batches.request(
        BatchRequest.Guarded({
          batch,
          claim: input.claim,
          failureCodeOnStalePayload: passReminderWithdrawnCode,
          prepare: Effect.gen(function* () {
            const { triggerPassId, locale, dotyposCustomerId } = input.run;
            const snapshot = decodePassReminderContext(
              input.run.passReminderContext
            );
            if (
              triggerPassId === null ||
              locale === null ||
              Option.isNone(snapshot) ||
              send.campaign.purpose !== "marketing" ||
              batch.dotyposCustomerIds.length !== 1 ||
              batch.dotyposCustomerIds[0] !== dotyposCustomerId
            )
              return Option.none();

            const profiles = yield* Option.match(input.profiles, {
              onSome: Effect.succeed,
              onNone: () => profilesFor(batch),
            });
            if (frozenEmailVersionId !== null) {
              const version = yield* getCampaignEmailVersion(
                db,
                frozenEmailVersionId
              );
              if (!version) return Option.none();
              const rendered = renderPassReminderPublishedEmail({
                document: version.document,
                reminder: { passId: triggerPassId, snapshot: snapshot.value },
                locale,
                profile: profiles.get(dotyposCustomerId),
              });
              if (Result.isFailure(rendered)) return Option.none();
              return Option.some({
                send: {
                  ...send,
                  campaign: {
                    ...send.campaign,
                    renderedByCustomer: new Map([
                      [dotyposCustomerId, rendered.success],
                    ]),
                  },
                },
                profiles,
                guard: guard({ run: input.run, batch, profiles }),
              });
            }
            return Option.some({
              send,
              profiles,
              guard: guard({ run: input.run, batch, profiles }),
            });
          }),
        })
      );

  return { prepare, request };
});

const incompleteRequest = ({ sendId, deliveryAttempt }: PersistedBatch) =>
  new CampaignDeliveryIncomplete({ sendId, deliveryAttempt });
