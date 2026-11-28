import type { DotyposCustomerId } from "@deskohub/dotypos";
import type { EmailVersionId } from "@deskohub/workspace-admin-api";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { Data, Effect, Option, Result } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceDatabaseClient,
  type WorkspaceTransaction,
} from "@/db/database.service";
import {
  emailCampaignAutomationVersions,
  emailCampaignRecipients,
  emailCampaignSends,
} from "@/db/schema";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import {
  type BatchOutcome,
  type BatchProfiles,
  type BatchRecipient,
  BatchRequest,
  CampaignBatchDelivery,
  CampaignDeliveryIncomplete,
  type DeliveredAttempt,
  type DeliveredCampaign,
  type PersistedBatch,
  PreparedBatch,
  type RenderedCustomerEmail,
} from "../../backend/campaign-batch-delivery.service";
import {
  getCampaignEmailVersion,
  renderAutomatedPublishedEmail,
} from "../../backend/campaign-published-email";
import type { CampaignDeliveryAttempt } from "../../backend/campaign-send-queue.service";
import { sendAutomationVersion } from "../../backend/campaign-send-selection";
import type { CampaignId, CampaignSendId } from "../../campaign-identifiers";
import type { AutomationVersionId } from "../automation-identifiers";

/**
 * What submitting an automated send found. `AlreadyCompleted`: an earlier
 * settlement completed the send, so nothing is left to record and its runs
 * already ended. `Submitted`: the outcome of each batch it requested, for
 * `settle`.
 */
export type AutomatedSendSubmission = Data.TaggedEnum<{
  AlreadyCompleted: Record<never, never>;
  Submitted: { readonly batches: readonly RequestedBatchOutcome[] };
}>;

export const AutomatedSendSubmission =
  Data.taggedEnum<AutomatedSendSubmission>();

/** A persisted batch with what its request settled as. */
type RequestedBatchOutcome = {
  readonly batch: PersistedBatch;
  readonly outcome: BatchOutcome;
};

/** Automated sends are never retried, so they deliver their first attempt only. */
const automatedAttempt = (sendId: CampaignSendId): CampaignDeliveryAttempt => ({
  sendId,
  deliveryAttempt: 1,
});

/**
 * Each recipient's rendering, in their persisted locale, of the frozen Email
 * Library email version an automated send's batch delivers. A missing
 * version or a rendering that fails leaves the batch unrequested.
 */
export const renderFrozenEmailForBatch = Effect.fn(
  "AutomatedCampaignSend.renderFrozenEmailForBatch"
)(function* (
  db: WorkspaceDatabaseClient,
  input: {
    readonly sendId: CampaignSendId;
    readonly batch: PersistedBatch;
    readonly frozenEmailVersionId: EmailVersionId;
  }
) {
  const version = yield* getCampaignEmailVersion(
    db,
    input.frozenEmailVersionId
  );
  if (!version) {
    return yield* new CampaignDeliveryIncomplete({
      sendId: input.batch.sendId,
      deliveryAttempt: input.batch.deliveryAttempt,
    });
  }
  const recipientRows = yield* db
    .select({
      dotyposCustomerId: emailCampaignRecipients.dotyposCustomerId,
      locale: emailCampaignRecipients.locale,
    })
    .from(emailCampaignRecipients)
    .where(
      and(
        eq(emailCampaignRecipients.sendId, input.sendId),
        inArray(emailCampaignRecipients.dotyposCustomerId, [
          ...input.batch.dotyposCustomerIds,
        ])
      )
    );
  const rendered = new Map<DotyposCustomerId, RenderedCustomerEmail>();
  for (const recipient of recipientRows) {
    const content = renderAutomatedPublishedEmail({
      document: version.document,
      recipientLocale: recipient.locale,
    });
    if (Result.isFailure(content)) {
      return yield* new CampaignDeliveryIncomplete({
        sendId: input.batch.sendId,
        deliveryAttempt: input.batch.deliveryAttempt,
      });
    }
    rendered.set(recipient.dotyposCustomerId, content.success);
  }
  return rendered;
});

/**
 * The send steps of a deliver unit (§5.9) over the campaign batch protocol.
 * The unit's claim stands in for a one-off send's lease, and its own
 * transactions interleave its run moves with these steps.
 */
export const makeAutomatedCampaignSend = Effect.gen(function* () {
  const { db } = yield* WorkspaceDatabase;
  const batches = yield* CampaignBatchDelivery;

  /**
   * The campaign email that the version of the automated send `send`
   * selects pins, if such a send exists.
   */
  const automatedCampaignOf = (
    send: SQL | undefined
  ): Effect.Effect<
    Option.Option<{
      readonly campaign: DeliveredCampaign;
      readonly frozenEmailVersionId: EmailVersionId | null;
    }>,
    DatabaseQueryError
  > =>
    db
      .select({
        id: emailCampaignSends.campaignId,
        purpose: emailCampaignAutomationVersions.purpose,
        templateKey: emailCampaignAutomationVersions.templateKey,
        content: emailCampaignAutomationVersions.content,
        frozenEmailVersionId:
          emailCampaignAutomationVersions.frozenEmailVersionId,
      })
      .from(emailCampaignSends)
      .innerJoin(emailCampaignAutomationVersions, sendAutomationVersion)
      .where(send)
      .pipe(
        Effect.map(([row]) =>
          Option.map(
            Option.fromNullishOr(row),
            ({ frozenEmailVersionId, ...campaign }) => ({
              campaign,
              frozenEmailVersionId,
            })
          )
        )
      );

  /** The automated send's first attempt with the email its version pins. */
  const deliveredAttempt = (sendId: CampaignSendId) =>
    automatedCampaignOf(eq(emailCampaignSends.id, sendId)).pipe(
      Effect.map(
        (found): DeliveredAttempt => ({
          ...automatedAttempt(sendId),
          campaign: Option.getOrThrow(found).campaign,
        })
      )
    );

  /**
   * The campaign email of an automated send its deliver unit hasn't
   * settled yet, whatever its campaign's status.
   */
  const uncompletedAutomatedCampaign = (sendId: CampaignSendId) =>
    automatedCampaignOf(
      and(
        eq(emailCampaignSends.id, sendId),
        eq(emailCampaignSends.deliveryAttempt, 1),
        isNull(emailCampaignSends.completedAt)
      )
    );

  /**
   * §5.9 step 2, in a deliver unit's commit transaction: creates the
   * automated send of the version, with the version's audience snapshot and
   * content hash.
   */
  const create = (input: {
    readonly campaignId: CampaignId;
    readonly versionId: AutomationVersionId;
    readonly at: Temporal.Instant;
  }): Effect.Effect<CampaignSendId, DatabaseQueryError, WorkspaceTransaction> =>
    db
      .select({
        audienceFilter: emailCampaignAutomationVersions.audienceFilter,
        contentHash: emailCampaignAutomationVersions.contentHash,
      })
      .from(emailCampaignAutomationVersions)
      .where(
        and(
          eq(emailCampaignAutomationVersions.id, input.versionId),
          eq(emailCampaignAutomationVersions.campaignId, input.campaignId)
        )
      )
      .pipe(
        Effect.flatMap(([version]) =>
          version === undefined
            ? Effect.die("Automation version of the send was not found.")
            : db
                .insert(emailCampaignSends)
                .values({
                  campaignId: input.campaignId,
                  automationVersionId: input.versionId,
                  audienceFilter: version.audienceFilter,
                  contentHash: version.contentHash,
                  createdAt: input.at,
                })
                .returning({ id: emailCampaignSends.id })
        ),
        Effect.flatMap(([send]) =>
          send === undefined
            ? Effect.die("Campaign send insert returned no row.")
            : Effect.succeed(send.id)
        )
      );

  /**
   * §5.9 step 2, after the runs moved to `sending`: freezes their
   * recipients and persists them as batch 0 from the profiles the unit
   * read, before any request. The delivery recheck skips whoever fails it;
   * rendering that fails fails the rest, as nothing was requested. A
   * `guarded` batch can only be requested through a guard
   * (`BatchRequest.Guarded`); `renderedByCustomer` carries each
   * recipient's rendering of the version's frozen Email Library email.
   */
  const persistBatch = (input: {
    readonly sendId: CampaignSendId;
    readonly recipients: readonly BatchRecipient[];
    readonly profiles: BatchProfiles;
    readonly at: Temporal.Instant;
    readonly renderedByCustomer?: ReadonlyMap<
      DotyposCustomerId,
      RenderedCustomerEmail
    >;
    readonly guarded?: true;
  }): Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction> =>
    db
      .insert(emailCampaignRecipients)
      .values(
        input.recipients.map((recipient) => ({
          ...recipient,
          sendId: input.sendId,
          statusUpdatedAt: input.at,
        }))
      )
      .pipe(
        Effect.andThen(deliveredAttempt(input.sendId)),
        Effect.flatMap((send) =>
          batches.prepare({
            send: {
              ...send,
              ...(input.guarded && { guarded: true }),
              campaign: {
                ...send.campaign,
                ...(input.renderedByCustomer && {
                  renderedByCustomer: input.renderedByCustomer,
                }),
              },
            },
            recipients: input.recipients,
            profiles: Option.some(input.profiles),
          })
        ),
        Effect.tap(
          PreparedBatch.$match({
            Rendered: () => Effect.void,
            Unrendered: ({ cause }) =>
              Effect.logError("Automated send batch could not be rendered", {
                errorType: cause._tag,
              }),
          })
        ),
        // The unit read the profiles, so nothing here reads Dotypos.
        Effect.catchTags({
          DotyposUnavailable: Effect.die,
          DotyposRejected: Effect.die,
          CampaignDeliveryIncomplete: Effect.die,
        }),
        Effect.flatMap((prepared) =>
          batches
            .persist({ prepared, at: input.at })
            .pipe(Effect.catchTag("CampaignDeliveryIncomplete", Effect.die))
        ),
        Effect.asVoid,
        Effect.withSpan("AutomatedCampaignSend.persistBatch")
      );

  /**
   * §5.9 step 3: requests the send's persisted batch under its key and
   * returns each batch's outcome for step 4. With the profiles the batch was
   * persisted from, it's the first request; without them it replays the
   * batch, re-reading its recipients, and past the replay window the batch
   * is `Unconfirmed`. A guarded send's batches go through `requestGuarded`
   * instead. A send already completed requests nothing. An unknown outcome
   * fails, so the unit retries the replay.
   */
  const submit = Effect.fn("AutomatedCampaignSend.submit")(
    function* (input: {
      readonly sendId: CampaignSendId;
      readonly profiles: Option.Option<BatchProfiles>;
      readonly requestGuarded?: (
        send: DeliveredAttempt,
        batch: PersistedBatch,
        frozenEmailVersionId: EmailVersionId | null
      ) => Effect.Effect<
        BatchOutcome,
        CampaignDeliveryIncomplete | DatabaseQueryError
      >;
    }) {
      const found = yield* uncompletedAutomatedCampaign(input.sendId);
      if (Option.isNone(found))
        return AutomatedSendSubmission.AlreadyCompleted();

      const { campaign, frozenEmailVersionId } = found.value;
      const attempt = automatedAttempt(input.sendId);
      const send = { ...attempt, campaign };
      const requested = yield* batches.listRequested(attempt);
      const submitted = yield* Effect.forEach(
        requested,
        Effect.fnUntraced(function* (batch) {
          if (input.requestGuarded) {
            const outcome = yield* input.requestGuarded(
              send,
              batch,
              frozenEmailVersionId
            );
            return { batch, outcome };
          }
          const sendWithEmail =
            frozenEmailVersionId !== null
              ? {
                  ...send,
                  campaign: {
                    ...send.campaign,
                    renderedByCustomer: yield* renderFrozenEmailForBatch(db, {
                      sendId: input.sendId,
                      batch,
                      frozenEmailVersionId,
                    }),
                  },
                }
              : send;
          const outcome = yield* batches.request(
            batchRequest({
              send: sendWithEmail,
              batch,
              profiles: input.profiles,
            })
          );
          return { batch, outcome };
        })
      );
      return AutomatedSendSubmission.Submitted({ batches: submitted });
    },
    (effect, input) =>
      effect.pipe(Effect.annotateLogs({ sendId: input.sendId }))
  );

  /**
   * §5.9 step 4, in the caller's transaction: records a submitted send's
   * batch outcomes on the batches and their recipients, then completes the
   * send. An automated send is never retried, so it completes however its
   * batch settled. Its campaign's status belongs to the automation's
   * lifecycle and stays as it is; its runs are the caller's.
   */
  const settle = (input: {
    readonly sendId: CampaignSendId;
    readonly batches: readonly RequestedBatchOutcome[];
    readonly at: Temporal.Instant;
  }): Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction> =>
    Effect.forEach(
      input.batches,
      ({ batch, outcome }) => batches.settle({ batch, outcome, at: input.at }),
      { discard: true }
    ).pipe(
      Effect.andThen(
        db
          .update(emailCampaignSends)
          .set({ completedAt: input.at })
          .where(eq(emailCampaignSends.id, input.sendId))
      ),
      Effect.asVoid,
      Effect.withSpan("AutomatedCampaignSend.settle")
    );

  return { create, persistBatch, submit, settle };
});

/**
 * A batch's request from the deliver unit: its first with the profiles this
 * invocation read, or a replay by a unit claimed again.
 */
const batchRequest = (input: {
  readonly send: DeliveredAttempt;
  readonly batch: PersistedBatch;
  readonly profiles: Option.Option<BatchProfiles>;
}): BatchRequest =>
  Option.match(input.profiles, {
    onSome: (profiles) =>
      BatchRequest.Reproduced({
        send: input.send,
        batch: input.batch,
        profiles,
      }),
    onNone: () =>
      BatchRequest.Replay({
        send: input.send,
        batch: input.batch,
        admit: Effect.void,
      }),
  });
