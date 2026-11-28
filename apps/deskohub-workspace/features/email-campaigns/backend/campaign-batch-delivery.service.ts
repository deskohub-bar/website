import "server-only";

import { createHmac } from "node:crypto";
import {
  type DotyposCustomer,
  type DotyposCustomerId,
  type DotyposReadFailure,
  DotyposService,
} from "@deskohub/dotypos";
import {
  type EmailBatchOptions,
  type EmailBatchResult,
  type EmailMessage,
  type EmailSendError,
  EmailServiceError,
  EmailServiceTag,
} from "@deskohub/email";
import { and, asc, eq, exists, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  Array as Arr,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Result,
  Semaphore,
} from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  emailCampaignAutomationWorkUnits,
  emailCampaignDeliveryBatches,
  emailCampaignRecipients,
} from "@/db/schema";
import { emailPreparations } from "@/db/schema/emails";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import {
  EmailPersistence,
  EmailRecipientPersistence,
} from "@/features/emails/backend";
import {
  type RenderedEmailContent,
  renderEmailContent,
} from "@/features/emails/body/email-content";
import { CustomerValues } from "@/features/emails/values/customer";
import { EmailDiscountValues } from "@/features/emails/values/discount";
import { EmailRecipientPreparation } from "@/features/emails/values/preparation";
import type { Locale } from "@/features/i18n";
import { AnalyticsConsentLedger } from "@/features/legal/backend/analytics-consent-ledger";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { WorkspaceEmailLayer } from "@/shared/backend/config/email.config";
import { currentInstant } from "@/shared/utils/temporal";
import type { AutomationWorkUnitId } from "../automation/automation-identifiers";
import type {
  CampaignLocalizedContent,
  CampaignPurpose,
  CampaignTemplateKey,
} from "../body/campaign-content";
import {
  campaignDeliveryBatchIdempotencyKey,
  campaignDeliveryBatchReplayWindow,
  campaignDeliveryPayloadHash,
} from "../campaign-delivery-batches";
import {
  CampaignDeliveryAudience,
  CampaignEmailOccasion,
  campaignEmailMessage,
} from "../campaign-email";
import type { CampaignId, CampaignSendId } from "../campaign-identifiers";
import {
  type CampaignRecipientSkipReason,
  undeliveredRecipientStatuses,
} from "../campaign-states";
import { campaignContentForRecipient } from "../recipient-locale";
import { CampaignEmailConfig } from "./campaign-email.config";
import {
  campaignOfferPreparationLayers,
  type FrozenCampaignEmail,
  readCampaignOfferEligibility,
  readCampaignRecipientContent,
  recordCampaignOfferOutcome,
} from "./campaign-personalized-delivery";
import {
  CampaignEligibilityStage,
  campaignEligibility,
  consentingCampaignCustomers,
} from "./campaign-reachability";
import { CampaignRecipientAnalyticsIdentity } from "./campaign-recipient-analytics-identity.service";
import type { CampaignDeliveryAttempt } from "./campaign-send-queue.service";
import { loadCampaignSigningKeys } from "./campaign-signing-keys";
import { CampaignUnsubscribeService } from "./campaign-unsubscribe.service";

/**
 * The attempt has batches left or a batch whose outcome is unknown, or
 * another run owns the send. Failing the queue message redelivers it, and
 * the next run resumes the attempt; a deliver unit fails and is redelivered
 * the same way.
 */
export class CampaignDeliveryIncomplete extends Data.TaggedError(
  "CampaignDeliveryIncomplete"
)<{
  readonly sendId: CampaignSendId;
  readonly deliveryAttempt: number;
}> {}

/**
 * The campaign email an attempt mails: an automated send's version pinned
 * its purpose, template and content, while a one-off send mails its
 * campaign's.
 */
export type RenderedCustomerEmail = {
  readonly locale: Locale;
  readonly content: RenderedEmailContent;
};

export type DeliveredCampaign = {
  readonly id: CampaignId;
  readonly purpose: CampaignPurpose;
  readonly templateKey: CampaignTemplateKey;
  readonly content: CampaignLocalizedContent;
  readonly publication?: FrozenCampaignEmail;
  /** Automated sends delivering a frozen published email render each recipient here. */
  readonly renderedByCustomer?: ReadonlyMap<
    DotyposCustomerId,
    RenderedCustomerEmail
  >;
};

/** An attempt with the campaign email it mails. */
export type DeliveredAttempt = CampaignDeliveryAttempt & {
  readonly campaign: DeliveredCampaign;
  readonly guarded?: true;
};

/** A frozen recipient a batch may carry. */
export type BatchRecipient = {
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly locale: Locale;
};

/** Dotypos profiles read for a batch's recipients. */
export type BatchProfiles = ReadonlyMap<DotyposCustomerId, DotyposCustomer>;

type BatchRequestMode = "first" | "replay";
export type BatchRequestClaim = {
  readonly unitId: AutomationWorkUnitId;
  readonly claimId: string;
};
type BatchRequestAdmission = {
  readonly guard: BatchRequestGuard;
  readonly claim: BatchRequestClaim;
  readonly preparedHash: string;
  readonly failureCodeOnStalePayload: string;
};

/** A rejected admission check proves nothing was attempted at that boundary. */
export type BatchRequestGuard = Effect.Effect<
  | true
  | { readonly skipReason: CampaignRecipientSkipReason }
  | { readonly failureCode: string },
  CampaignDeliveryIncomplete | DatabaseQueryError
>;

type ReachableRecipient = BatchRecipient & { readonly to: string };

type SkippedRecipient = {
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly reason: CampaignRecipientSkipReason;
};

type PreparationFailure = {
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly reason: "preparation-unavailable" | "preparation-failed";
  readonly priorUncertainty: boolean;
};

type RecipientRequestDenial = {
  readonly customerId: DotyposCustomerId;
  readonly reason:
    | "consent-withdrawn"
    | "offer-unavailable"
    | "recipient-payload-changed";
  readonly priorUncertainty: boolean;
};

type WithPreparationLease = <A, E>(
  prepare: Effect.Effect<A, E>
) => Effect.Effect<A, E | CampaignDeliveryIncomplete | DatabaseQueryError>;

type WithCampaignDeliveryLease = <A, E>(
  work: Effect.Effect<A, E, WorkspaceTransaction>
) => Effect.Effect<A, E | CampaignDeliveryIncomplete | DatabaseQueryError>;

/**
 * A batch persisted `requested` before any request: its key's identity, its
 * recipients in message order, the hash of its exact payload and its first
 * request's time.
 */
export type PersistedBatch = CampaignDeliveryAttempt & {
  readonly batchIndex: number;
  readonly dotyposCustomerIds: readonly DotyposCustomerId[];
  readonly payloadHash: string;
  readonly requestedAt: Temporal.Instant;
};

/**
 * A batch's recipients after the delivery recheck. `Rendered` holds the
 * message of every reachable recipient, in order. `Unrendered`: rendering
 * failed the same way it would every time, so nothing can be requested for
 * the reachable recipients.
 */
export type PreparedBatch = Data.TaggedEnum<{
  Rendered: {
    readonly send: DeliveredAttempt;
    readonly skipped: readonly SkippedRecipient[];
    readonly reachable: readonly ReachableRecipient[];
    readonly messages: readonly EmailMessage[];
    readonly preparationFailures?: readonly PreparationFailure[];
  };
  Unrendered: {
    readonly send: DeliveredAttempt;
    readonly skipped: readonly SkippedRecipient[];
    readonly reachable: readonly ReachableRecipient[];
    readonly cause: { readonly _tag: string };
  };
}>;

export const PreparedBatch = Data.taggedEnum<PreparedBatch>();

type PersonalizedBatchRequest = {
  readonly send: DeliveredAttempt;
  readonly withLease: WithCampaignDeliveryLease;
};

/**
 * One request of a persisted batch under its key. `First`: its first
 * request, with the messages its persist rendered in this run. `Reproduced`:
 * its first request in a later step than its persist, from the profiles it
 * was persisted from. `Replay`: an earlier request's outcome is unknown, so
 * its recipients are re-read; `admit` runs once the batch is within its
 * replay window and before anything is re-read, the caller's last chance to
 * stop.
 */
export type BatchRequest = Data.TaggedEnum<{
  First: {
    readonly batch: PersistedBatch;
    readonly messages: readonly EmailMessage[];
    readonly personalized?: PersonalizedBatchRequest;
  };
  Reproduced: {
    readonly send: DeliveredAttempt;
    readonly batch: PersistedBatch;
    readonly profiles: BatchProfiles;
  };
  Replay: {
    readonly send: DeliveredAttempt;
    readonly batch: PersistedBatch;
    readonly admit: Effect.Effect<
      void,
      CampaignDeliveryIncomplete | DatabaseQueryError
    >;
    readonly personalized?: PersonalizedBatchRequest;
  };
  Guarded: {
    readonly batch: PersistedBatch;
    readonly claim: BatchRequestClaim;
    readonly failureCodeOnStalePayload: string;
    readonly prepare: Effect.Effect<
      Option.Option<{
        readonly send: DeliveredAttempt;
        readonly profiles: BatchProfiles;
        readonly guard: BatchRequestGuard;
      }>,
      CampaignDeliveryIncomplete | DatabaseQueryError
    >;
  };
}>;

export const BatchRequest = Data.taggedEnum<BatchRequest>();

/**
 * What one email of an accepted batch settled as. `failed` means every
 * provider refused it; `unconfirmed` that one may have delivered it, so
 * only an admin retry that includes unconfirmed recipients resends it.
 * Both carry the last provider's error code, when it gave one.
 */
type RecipientOutcome =
  | { readonly status: "sent"; readonly providerMessageId: string }
  | {
      readonly status: "failed" | "unconfirmed";
      readonly failureCode: string | undefined;
    };

/**
 * What a batch's request settled as. `Accepted`: the providers answered
 * each email, with its outcome in the batch's order. `Refused`: the
 * provider refused the whole request and sent nothing, with its error code
 * when it gave one; a refused first request means the batch was never
 * mailed, while a refused replay says nothing about the earlier request. An
 * `Unconfirmed` batch may have been mailed and is never resent: its key's
 * replay window passed or its payload can't be reproduced. An unknown
 * outcome isn't one of these: the request fails with
 * `CampaignDeliveryIncomplete` and the batch stays `requested`.
 */
export type BatchOutcome = Data.TaggedEnum<{
  Accepted: { readonly recipients: readonly RecipientOutcome[] };
  Skipped: { readonly reason: CampaignRecipientSkipReason };
  Refused: {
    readonly request: BatchRequestMode;
    readonly failureCode: string | undefined;
    readonly definitivelyUnsent?: true;
  };
  Unconfirmed: { readonly reason: "key-expired" | "payload-changed" };
  Replanned: Record<never, never>;
}>;

export const BatchOutcome = Data.taggedEnum<BatchOutcome>();

type SettledBatchOutcome = Exclude<BatchOutcome, { _tag: "Replanned" }>;

/**
 * A batch whose outcome is unknown can't be replayed: its key's replay
 * window passed, or its payload can't be reproduced.
 */
class UnreplayableBatch extends Data.TaggedError("UnreplayableBatch")<{
  readonly reason: "key-expired" | "payload-changed";
  readonly skipReason?: CampaignRecipientSkipReason;
}> {}

export interface ICampaignBatchDelivery {
  /**
   * Re-checks a batch's recipients for delivery and renders their
   * messages. Each recipient's email (and, for marketing, consent) must
   * still hold, and outside production the address must be in the email
   * test domain; anyone who fails is skipped and never reaches the
   * provider. Without `profiles` it reads them from Dotypos. Consent is
   * read on the Workspace database, so inside a transaction it sees that
   * transaction's writes.
   */
  readonly prepare: (input: {
    readonly send: DeliveredAttempt;
    readonly recipients: readonly BatchRecipient[];
    readonly profiles: Option.Option<BatchProfiles>;
    readonly withPreparationLease?: WithPreparationLease;
  }) => Effect.Effect<
    PreparedBatch,
    DotyposReadFailure | DatabaseQueryError | CampaignDeliveryIncomplete
  >;
  /**
   * In the caller's transaction, before any request: marks the skipped
   * recipients and persists the reachable ones as the attempt's next
   * batch, `requested`, with the hash of its exact payload. An
   * `Unrendered` batch fails its reachable recipients instead, since
   * nothing was requested. None when no batch was persisted.
   */
  readonly persist: (input: {
    readonly prepared: PreparedBatch;
    readonly at: Temporal.Instant;
  }) => Effect.Effect<
    Option.Option<PersistedBatch>,
    CampaignDeliveryIncomplete | DatabaseQueryError,
    WorkspaceTransaction
  >;
  /**
   * In the caller's transaction: fails the given recipients still
   * `pending`. Nothing was requested for them, so a retry can't mail them
   * twice.
   */
  readonly failUnrequested: (input: {
    readonly sendId: CampaignSendId;
    readonly customerIds: readonly DotyposCustomerId[];
    readonly at: Temporal.Instant;
  }) => Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction>;
  /** The attempt's batches whose outcome is unknown, in request order. */
  readonly listRequested: (
    attempt: CampaignDeliveryAttempt
  ) => Effect.Effect<readonly PersistedBatch[], DatabaseQueryError>;
  /**
   * Requests a persisted batch under its key with exactly one provider
   * request, never retried here. A reproduced or replayed payload must hash
   * as persisted and the key must be within its replay window; otherwise
   * nothing is requested and the batch is `Unconfirmed`. An unknown outcome,
   * or a Dotypos re-read that failed, fails with
   * `CampaignDeliveryIncomplete` and leaves the batch for a replay; so does
   * a failed database read, with its own error.
   */
  readonly request: (
    request: BatchRequest
  ) => Effect.Effect<
    BatchOutcome,
    CampaignDeliveryIncomplete | DatabaseQueryError
  >;
  /**
   * In the caller's transaction: records a batch's outcome on the batch and
   * moves its recipients to what the outcome means.
   */
  readonly settle: (input: {
    readonly batch: PersistedBatch;
    readonly outcome: BatchOutcome;
    readonly at: Temporal.Instant;
    readonly personalized?: boolean;
  }) => Effect.Effect<void, DatabaseQueryError, WorkspaceTransaction>;
}

/**
 * The batch protocol of campaign delivery: persist a batch before its
 * request, request it under its key, replay it while its outcome is
 * unknown, and settle its outcome. The one-off lease driver and the
 * automation deliver unit both call it.
 */
export class CampaignBatchDelivery extends Context.Service<
  CampaignBatchDelivery,
  ICampaignBatchDelivery
>()("@deskohub-workspace/email-campaigns/CampaignBatchDelivery") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const dotypos = yield* DotyposService;
      const email = yield* EmailServiceTag;
      const config = yield* CampaignEmailConfig;
      const unsubscribe = yield* CampaignUnsubscribeService;
      const analyticsIdentity = yield* CampaignRecipientAnalyticsIdentity;
      const preparations = yield* EmailRecipientPreparation;
      const emailPersistence = yield* EmailPersistence;
      const recipientPersistence = yield* EmailRecipientPersistence;
      const discounts = yield* EmailDiscountValues;

      const prepare: ICampaignBatchDelivery["prepare"] = Effect.fn(
        "CampaignBatchDelivery.prepare"
      )(function* (input) {
        const classified = yield* Option.match(input.profiles, {
          onNone: () => hydrate(input),
          onSome: (profiles) =>
            loadConsenting({
              campaign: input.send.campaign,
              customerIds: input.recipients.map(
                ({ dotyposCustomerId }) => dotyposCustomerId
              ),
            }).pipe(
              Effect.map((consenting) =>
                classifyRecipients({
                  recipients: input.recipients,
                  profiles,
                  consenting,
                })
              )
            ),
        });
        const [reachable, skipped] = Arr.separate(classified);
        if (input.send.campaign.publication) {
          if (!input.withPreparationLease) return yield* incomplete(input.send);
          return yield* preparePersonalized(
            input.send,
            input.send.campaign.publication,
            reachable,
            skipped,
            input.withPreparationLease
          );
        }
        return yield* renderMessages({
          send: input.send,
          recipients: reachable,
        }).pipe(
          Effect.map((messages) =>
            PreparedBatch.Rendered({
              send: input.send,
              skipped,
              reachable,
              messages,
            })
          ),
          Effect.catchTags({
            EmailServiceError: (cause) =>
              unrendered({ send: input.send, skipped, reachable, cause }),
            WorkspaceUrlConfigError: (cause) =>
              unrendered({ send: input.send, skipped, reachable, cause }),
          })
        );
      });

      const loadConsenting = (input: {
        readonly campaign: DeliveredCampaign;
        readonly customerIds: readonly DotyposCustomerId[];
      }) =>
        consentingCampaignCustomers({
          db,
          purpose: input.campaign.purpose,
          customerIds: input.customerIds,
        });

      /**
       * Re-reads each recipient's email and, for marketing, consent, then
       * classifies them. Nothing reaches the provider without passing here.
       */
      const hydrate = (input: {
        readonly send: DeliveredAttempt;
        readonly recipients: readonly BatchRecipient[];
      }) =>
        Effect.Do.pipe(
          Effect.let("customerIds", () =>
            input.recipients.map(({ dotyposCustomerId }) => dotyposCustomerId)
          ),
          Effect.bind("profiles", ({ customerIds }) =>
            dotypos.getCustomersByIds(customerIds)
          ),
          Effect.bind("consenting", ({ customerIds }) =>
            loadConsenting({ campaign: input.send.campaign, customerIds })
          ),
          Effect.map(({ profiles, consenting }) =>
            classifyRecipients({
              recipients: input.recipients,
              profiles,
              consenting,
            })
          ),
          Effect.withSpan("CampaignBatchDelivery.hydrate")
        );

      /** The address to mail the recipient at, or why they're skipped. */
      const classifyRecipient = (input: {
        readonly recipient: BatchRecipient;
        readonly profiles: BatchProfiles;
        readonly consenting: ReadonlySet<DotyposCustomerId>;
      }): Result.Result<ReachableRecipient, SkippedRecipient> => {
        const { recipient } = input;
        const skip = (reason: CampaignRecipientSkipReason) => ({
          dotyposCustomerId: recipient.dotyposCustomerId,
          reason,
        });
        return campaignEligibility({
          profile: Option.fromNullishOr(
            input.profiles.get(recipient.dotyposCustomerId)
          ),
          stage: CampaignEligibilityStage.Delivery({
            consenting: input.consenting.has(recipient.dotyposCustomerId),
            deploymentEnvironment: config.deploymentEnvironment,
          }),
        }).pipe(
          Result.map((to) => ({ ...recipient, to })),
          Result.mapError(skip)
        );
      };

      const classifyRecipients = (input: {
        readonly recipients: readonly BatchRecipient[];
        readonly profiles: BatchProfiles;
        readonly consenting: ReadonlySet<DotyposCustomerId>;
      }) =>
        input.recipients.map((recipient) =>
          classifyRecipient({ ...input, recipient })
        );

      const renderMessage = (input: {
        readonly send: DeliveredAttempt;
        readonly recipient: ReachableRecipient;
        readonly showHeaderArtwork?: boolean | undefined;
        readonly personalizedContent?: RenderedEmailContent;
      }) =>
        Effect.succeed(input).pipe(
          Effect.let("recipientTags", ({ send, recipient }) => ({
            sendId: send.sendId,
            dotyposCustomerId: recipient.dotyposCustomerId,
          })),
          Effect.bind("audience", ({ send, recipientTags }) =>
            Match.value(send.campaign.purpose).pipe(
              Match.when("marketing", () =>
                unsubscribe
                  .unsubscribeUrl(recipientTags)
                  .pipe(
                    Effect.map((unsubscribeUrl) =>
                      CampaignDeliveryAudience.Marketing({ unsubscribeUrl })
                    )
                  )
              ),
              Match.when("operational", () =>
                Effect.succeed(CampaignDeliveryAudience.Operational())
              ),
              Match.exhaustive
            )
          ),
          Effect.let(
            "localized",
            ({ send, recipient, personalizedContent }) => {
              if (personalizedContent) {
                return {
                  locale: recipient.locale,
                  content: personalizedContent,
                  sensitive: true,
                };
              }
              const rendered = send.campaign.renderedByCustomer?.get(
                recipient.dotyposCustomerId
              );
              if (rendered) {
                return { ...rendered, sensitive: true };
              }
              return {
                ...campaignContentForRecipient(
                  send.campaign.content,
                  recipient.locale
                ),
                sensitive: false,
              };
            }
          ),
          Effect.flatMap(
            ({
              send,
              recipient,
              recipientTags,
              audience,
              localized,
              showHeaderArtwork,
            }) =>
              campaignEmailMessage({
                templateKey: send.campaign.templateKey,
                locale: localized.locale,
                content: localized.content,
                occasion: CampaignEmailOccasion.Delivery({
                  to: recipient.to,
                  recipient: recipientTags,
                  audience,
                  showHeaderArtwork,
                }),
                sender: config,
                deploymentEnvironment: config.deploymentEnvironment,
              }).pipe(
                Effect.map((message) =>
                  localized.sensitive
                    ? { ...message, sensitiveContent: true }
                    : message
                )
              )
          ),
          Effect.withSpan("CampaignBatchDelivery.renderMessage")
        );

      const renderMessages = (input: {
        readonly send: DeliveredAttempt;
        readonly recipients: readonly ReachableRecipient[];
        readonly showHeaderArtwork?: boolean | undefined;
      }) =>
        Effect.forEach(input.recipients, (recipient) =>
          renderMessage({ ...input, recipient })
        );

      const preparePersonalized = Effect.fn(
        "CampaignBatchDelivery.preparePersonalized"
      )(function* (
        send: DeliveredAttempt,
        publication: FrozenCampaignEmail,
        eligible: readonly ReachableRecipient[],
        skipped: readonly SkippedRecipient[],
        withPreparationLease: WithPreparationLease
      ) {
        const version = yield* emailPersistence
          .getVersion(publication.versionId)
          .pipe(Effect.catchTag("EmailVersionInvalid", () => incomplete(send)));
        if (
          !version ||
          version.emailId !== publication.emailId ||
          version.document.purpose !== "marketing" ||
          version.document.templateKey !== send.campaign.templateKey
        )
          return yield* incomplete(send);
        const reachable: ReachableRecipient[] = [];
        const messages: EmailMessage[] = [];
        const preparationFailures: PreparationFailure[] = [];
        const allSkipped = [...skipped];
        for (const recipient of eligible) {
          const { dotyposCustomerId, locale } = recipient;
          const prepared = yield* withPreparationLease(
            preparations.prepare({
              sendId: send.sendId,
              dotyposCustomerId,
              locale,
              emailVersionId: publication.versionId,
            })
          ).pipe(
            Effect.catchTags({
              EmailPreparationConflict: () => incomplete(send),
              EmailVersionInvalid: () => incomplete(send),
            })
          );
          const priorUncertainty =
            prepared.preparation.deliveryOutcome === "uncertain";
          if (
            prepared._tag === "Skipped" &&
            prepared.reason === "missing-language"
          ) {
            allSkipped.push({
              dotyposCustomerId,
              reason: "missing-email-language",
            });
            continue;
          }
          if (prepared._tag !== "Ready") {
            preparationFailures.push({
              dotyposCustomerId,
              priorUncertainty,
              reason:
                prepared._tag === "Unavailable"
                  ? "preparation-unavailable"
                  : "preparation-failed",
            });
            continue;
          }
          const { version, preparation, values } = prepared;
          if (
            version.id !== publication.versionId ||
            version.emailId !== publication.emailId ||
            version.document.purpose !== "marketing" ||
            version.document.templateKey !== send.campaign.templateKey ||
            (preparation.deliveryOutcome !== "pending" &&
              // A known unrequested batch may have been removed by admission.
              preparation.deliveryOutcome !== "delivering" &&
              preparation.deliveryOutcome !== "uncertain")
          ) {
            preparationFailures.push({
              dotyposCustomerId,
              priorUncertainty,
              reason: "preparation-failed",
            });
            continue;
          }
          const content = renderEmailContent({
            document: version.document,
            locale,
            values: Object.fromEntries(values),
          });
          const message = yield* Result.isSuccess(content)
            ? renderMessage({
                send,
                recipient,
                personalizedContent: content.success,
              }).pipe(
                Effect.catchTags({
                  EmailServiceError: () => Effect.undefined,
                  WorkspaceUrlConfigError: () => incomplete(send),
                })
              )
            : Effect.undefined;
          if (message) {
            reachable.push(recipient);
            messages.push(message);
          } else {
            preparationFailures.push({
              dotyposCustomerId,
              priorUncertainty,
              reason: "preparation-failed",
            });
          }
        }
        const customerIds = reachable.map(
          ({ dotyposCustomerId }) => dotyposCustomerId
        );
        return PreparedBatch.Rendered({
          send,
          reachable,
          skipped: allSkipped,
          messages: messagesWithIdentities(
            messages,
            customerIds,
            yield* analyticsIdentity.forRecipients(customerIds)
          ),
          preparationFailures,
        });
      });

      const offerOutcome = (
        input: Parameters<typeof recordCampaignOfferOutcome>[0]
      ) =>
        recordCampaignOfferOutcome(input).pipe(
          Effect.provideService(EmailDiscountValues, discounts)
        );

      const pinRecipientPayloads = Effect.fn(
        "CampaignBatchDelivery.pinRecipientPayloads"
      )(function* (
        prepared: Extract<PreparedBatch, { _tag: "Rendered" }>,
        at: Temporal.Instant
      ) {
        const { db } = yield* WorkspaceTransaction;
        const { send, reachable, messages } = prepared;
        if (reachable.length === 0) return { prepared, payload: messages };
        const customerIds = reachable.map(
          ({ dotyposCustomerId }) => dotyposCustomerId
        );
        const keys = yield* loadCampaignSigningKeys("recipient-payload").pipe(
          Effect.catch(() => incomplete(send))
        );
        const rows = yield* db
          .select({
            id: emailCampaignRecipients.dotyposCustomerId,
            fingerprint: emailCampaignRecipients.payloadFingerprint,
            outcome: emailPreparations.deliveryOutcome,
          })
          .from(emailCampaignRecipients)
          .innerJoin(
            emailPreparations,
            and(
              eq(emailPreparations.sendId, emailCampaignRecipients.sendId),
              eq(
                emailPreparations.dotyposCustomerId,
                emailCampaignRecipients.dotyposCustomerId
              )
            )
          )
          .where(
            and(
              eq(emailCampaignRecipients.sendId, send.sendId),
              eq(emailCampaignRecipients.deliveryAttempt, send.deliveryAttempt),
              eq(emailCampaignRecipients.status, "pending"),
              inArray(emailCampaignRecipients.dotyposCustomerId, customerIds)
            )
          );
        const byId = new Map(rows.map((row) => [row.id, row]));
        const pinned: ReachableRecipient[] = [];
        const matchingPayload: EmailMessage[] = [];
        for (const [recipient, message] of Arr.zip(reachable, messages)) {
          const id = recipient.dotyposCustomerId;
          const row = byId.get(id);
          if (!row) return yield* incomplete(send);
          const digests = Arr.map(keys, (key) =>
            createHmac("sha256", key)
              .update(JSON.stringify([send.sendId, id, message]))
              .digest("hex")
          );
          if (row.fingerprint === null && row.outcome === "pending") {
            const [written] = yield* db
              .update(emailCampaignRecipients)
              .set({ payloadFingerprint: digests[0] })
              .where(
                and(
                  eq(emailCampaignRecipients.sendId, send.sendId),
                  eq(emailCampaignRecipients.dotyposCustomerId, id),
                  isNull(emailCampaignRecipients.payloadFingerprint)
                )
              )
              .returning({ id: emailCampaignRecipients.dotyposCustomerId });
            if (!written) return yield* incomplete(send);
          } else if (
            row.fingerprint === null ||
            !digests.includes(row.fingerprint)
          ) {
            yield* settlePendingRecipients({
              sendId: send.sendId,
              customerIds: [id],
              status: row.outcome === "uncertain" ? "unconfirmed" : "failed",
              failureCode: "recipient-payload-changed",
              at,
            });
            yield* offerOutcome({
              sendId: send.sendId,
              customerIds: [id],
              outcome: "definitively-unsent",
            });
            continue;
          }
          pinned.push(recipient);
          matchingPayload.push(message);
        }
        return {
          prepared: { ...prepared, reachable: pinned },
          payload: matchingPayload,
        };
      });

      const persistPersonalization = Effect.fn(
        "CampaignBatchDelivery.persistPersonalization"
      )(function* (
        {
          send,
          reachable,
          skipped,
          preparationFailures = [],
        }: Extract<PreparedBatch, { _tag: "Rendered" }>,
        at: Temporal.Instant
      ) {
        yield* Effect.forEach(
          preparationFailures,
          ({ dotyposCustomerId, reason, priorUncertainty }) =>
            settlePendingRecipients({
              sendId: send.sendId,
              customerIds: [dotyposCustomerId],
              status: priorUncertainty ? "unconfirmed" : "failed",
              failureCode: reason,
              at,
            }),
          { discard: true }
        );
        yield* offerOutcome({
          sendId: send.sendId,
          customerIds: [
            ...skipped.map(({ dotyposCustomerId }) => dotyposCustomerId),
            ...preparationFailures
              .filter(({ reason }) => reason === "preparation-failed")
              .map(({ dotyposCustomerId }) => dotyposCustomerId),
          ],
          outcome: "definitively-unsent",
        });
        yield* offerOutcome({
          sendId: send.sendId,
          customerIds: reachable.map(
            ({ dotyposCustomerId }) => dotyposCustomerId
          ),
          outcome: "delivering",
        });
      });

      const persist: ICampaignBatchDelivery["persist"] = Effect.fn(
        "CampaignBatchDelivery.persist"
      )(function* ({ prepared, at }) {
        yield* markSkipped({
          sendId: prepared.send.sendId,
          skipped: prepared.skipped,
          at,
        });
        return yield* PreparedBatch.$match(prepared, {
          Rendered: Effect.fnUntraced(function* (rendered) {
            const { send } = rendered;
            const personalized = send.campaign.publication;
            const plan = personalized
              ? yield* pinRecipientPayloads(rendered, at)
              : { prepared: rendered, payload: rendered.messages };
            if (personalized) yield* persistPersonalization(plan.prepared, at);
            if (plan.prepared.reachable.length === 0)
              return Option.none<PersistedBatch>();
            return yield* insertBatch({
              attempt: send,
              reachable: plan.prepared.reachable,
              payloadHash: `${send.guarded ? guardedPayloadPrefix : ""}${campaignDeliveryPayloadHash(plan.payload)}`,
              at,
            }).pipe(Effect.asSome);
          }),
          Unrendered: ({ send, reachable }) =>
            settlePendingRecipients({
              sendId: send.sendId,
              customerIds: reachable.map(
                ({ dotyposCustomerId }) => dotyposCustomerId
              ),
              status: "failed",
              at,
            }).pipe(Effect.as(Option.none<PersistedBatch>())),
        });
      });

      const markSkipped = (input: {
        readonly sendId: CampaignSendId;
        readonly skipped: readonly SkippedRecipient[];
        readonly at: Temporal.Instant;
      }) =>
        Effect.forEach(input.skipped, ({ dotyposCustomerId, reason }) =>
          db
            .update(emailCampaignRecipients)
            .set({
              status: "skipped",
              skipReason: reason,
              statusUpdatedAt: input.at,
            })
            .where(
              and(
                eq(emailCampaignRecipients.sendId, input.sendId),
                eq(
                  emailCampaignRecipients.dotyposCustomerId,
                  dotyposCustomerId
                ),
                eq(emailCampaignRecipients.status, "pending")
              )
            )
        );

      const nextBatchIndex = (attempt: CampaignDeliveryAttempt) =>
        db
          .select({
            batchIndex: sql<number>`coalesce(max(${emailCampaignDeliveryBatches.batchIndex}), -1)::int`,
          })
          .from(emailCampaignDeliveryBatches)
          .where(
            and(
              eq(emailCampaignDeliveryBatches.sendId, attempt.sendId),
              eq(
                emailCampaignDeliveryBatches.deliveryAttempt,
                attempt.deliveryAttempt
              )
            )
          )
          .pipe(Effect.map(([last]) => (last?.batchIndex ?? -1) + 1));

      const insertBatch = (input: {
        readonly attempt: CampaignDeliveryAttempt;
        readonly reachable: readonly ReachableRecipient[];
        readonly payloadHash: string;
        readonly at: Temporal.Instant;
      }) =>
        nextBatchIndex(input.attempt).pipe(
          Effect.map(
            (batchIndex): PersistedBatch => ({
              sendId: input.attempt.sendId,
              deliveryAttempt: input.attempt.deliveryAttempt,
              batchIndex,
              dotyposCustomerIds: input.reachable.map(
                ({ dotyposCustomerId }) => dotyposCustomerId
              ),
              payloadHash: input.payloadHash,
              requestedAt: input.at,
            })
          ),
          Effect.tap((batch) =>
            db.insert(emailCampaignDeliveryBatches).values({
              sendId: batch.sendId,
              deliveryAttempt: batch.deliveryAttempt,
              batchIndex: batch.batchIndex,
              dotyposCustomerIds: [...batch.dotyposCustomerIds],
              payloadHash: batch.payloadHash,
              requestedAt: batch.requestedAt,
            })
          )
        );

      /**
       * Moves the given recipients that are still `pending` to `status`,
       * with the refusal's code when they failed.
       */
      const settlePendingRecipients = (input: {
        readonly sendId: CampaignSendId;
        readonly customerIds: readonly DotyposCustomerId[];
        readonly status: "failed" | "unconfirmed";
        readonly failureCode?: string | undefined;
        readonly at: Temporal.Instant;
      }) =>
        db
          .update(emailCampaignRecipients)
          .set({
            status: input.status,
            failureCode: input.failureCode ?? null,
            statusUpdatedAt: input.at,
          })
          .where(
            and(
              eq(emailCampaignRecipients.sendId, input.sendId),
              inArray(emailCampaignRecipients.dotyposCustomerId, [
                ...input.customerIds,
              ]),
              eq(emailCampaignRecipients.status, "pending")
            )
          );

      const failUnrequested: ICampaignBatchDelivery["failUnrequested"] =
        Effect.fn("CampaignBatchDelivery.failUnrequested")(function* (input) {
          yield* settlePendingRecipients({ ...input, status: "failed" });
        });

      const listRequested: ICampaignBatchDelivery["listRequested"] = (
        attempt
      ) =>
        db
          .select({
            batchIndex: emailCampaignDeliveryBatches.batchIndex,
            dotyposCustomerIds: emailCampaignDeliveryBatches.dotyposCustomerIds,
            payloadHash: emailCampaignDeliveryBatches.payloadHash,
            requestedAt: emailCampaignDeliveryBatches.requestedAt,
          })
          .from(emailCampaignDeliveryBatches)
          .where(
            and(
              eq(emailCampaignDeliveryBatches.sendId, attempt.sendId),
              eq(
                emailCampaignDeliveryBatches.deliveryAttempt,
                attempt.deliveryAttempt
              ),
              eq(emailCampaignDeliveryBatches.status, "requested")
            )
          )
          .orderBy(asc(emailCampaignDeliveryBatches.batchIndex))
          .pipe(
            Effect.map((rows) =>
              rows.map(
                (row): PersistedBatch => ({
                  sendId: attempt.sendId,
                  deliveryAttempt: attempt.deliveryAttempt,
                  ...row,
                })
              )
            )
          );

      /** A persisted batch's recipients, in the batch's message order. */
      const loadBatchRecipients = (batch: PersistedBatch) =>
        db
          .select({
            dotyposCustomerId: emailCampaignRecipients.dotyposCustomerId,
            locale: emailCampaignRecipients.locale,
          })
          .from(emailCampaignRecipients)
          .where(
            and(
              eq(emailCampaignRecipients.sendId, batch.sendId),
              inArray(emailCampaignRecipients.dotyposCustomerId, [
                ...batch.dotyposCustomerIds,
              ])
            )
          )
          .pipe(
            Effect.map((rows) => {
              const byId = new Map(
                rows.map((row) => [row.dotyposCustomerId, row])
              );
              return batch.dotyposCustomerIds.flatMap((id) => {
                const row = byId.get(id);
                return row ? [row] : [];
              });
            })
          );

      const request: ICampaignBatchDelivery["request"] = Effect.fn(
        "CampaignBatchDelivery.request"
      )(function* (input) {
        return yield* BatchRequest.$match(input, {
          First: ({ batch, messages, personalized }) =>
            sendBatch({ batch, messages, request: "first", personalized }),
          Reproduced: ({ batch, send, profiles }) =>
            requestReproduced({
              batch,
              mode: "first",
              prepare: Effect.succeed({
                send,
                profiles: Option.some(profiles),
              }),
            }),
          Replay: ({ batch, send, admit, personalized }) =>
            requestReproduced({
              batch,
              mode: "replay",
              prepare: admit.pipe(
                Effect.as({
                  send,
                  profiles: Option.none<BatchProfiles>(),
                  ...(personalized && { personalized }),
                })
              ),
            }),
          Guarded: ({ batch, claim, prepare, failureCodeOnStalePayload }) => {
            const [, preparedHash, providerHash] =
              /^guarded-v1:([a-f0-9]{64})(?::([a-f0-9]{64}))?$/.exec(
                batch.payloadHash
              ) ?? [];
            if (preparedHash === undefined) {
              return Effect.succeed(
                BatchOutcome.Unconfirmed({ reason: "payload-changed" })
              );
            }
            return requestReproduced({
              batch,
              mode: providerHash === undefined ? "first" : "replay",
              failureCodeOnStalePayload,
              prepare: prepare.pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(payloadChanged()),
                    onSome: ({ send, profiles, guard }) =>
                      Effect.succeed({
                        send,
                        profiles: Option.some(profiles),
                        admission: {
                          guard,
                          claim,
                          preparedHash,
                          failureCodeOnStalePayload,
                        },
                      }),
                  })
                )
              ),
            });
          },
        });
      });

      /**
       * Requests a persisted batch with its reproduced payload, within its
       * key's replay window. A batch that can't be requested again is
       * `Unconfirmed`.
       */
      const requestReproduced = (input: {
        readonly batch: PersistedBatch;
        readonly mode: BatchRequestMode;
        readonly failureCodeOnStalePayload?: string;
        readonly prepare: Effect.Effect<
          {
            readonly send: DeliveredAttempt;
            readonly profiles: Option.Option<BatchProfiles>;
            readonly admission?: BatchRequestAdmission;
            readonly personalized?: PersonalizedBatchRequest;
          },
          CampaignDeliveryIncomplete | DatabaseQueryError | UnreplayableBatch
        >;
      }) =>
        ensureReplayWindow(input.batch).pipe(
          Effect.andThen(input.prepare),
          Effect.flatMap(({ send, profiles, admission, personalized }) =>
            reproducePayload({
              send,
              batch: input.batch,
              profiles,
              payloadHash: admission?.preparedHash ?? input.batch.payloadHash,
              recheckConsent: admission !== undefined,
            }).pipe(
              Effect.flatMap((messages) =>
                sendBatch({
                  batch: input.batch,
                  messages,
                  request: input.mode,
                  admission,
                  personalized,
                })
              )
            )
          ),
          Effect.catchTag(
            "UnreplayableBatch",
            ({ reason, skipReason }): Effect.Effect<BatchOutcome> => {
              if (input.mode === "first" && input.failureCodeOnStalePayload) {
                if (skipReason !== undefined) {
                  return Effect.succeed(
                    BatchOutcome.Skipped({ reason: skipReason })
                  );
                }
                return Effect.succeed(
                  BatchOutcome.Refused({
                    request: "first",
                    failureCode: input.failureCodeOnStalePayload,
                  })
                );
              }
              return Effect.logWarning("Campaign delivery batch unconfirmed", {
                batchIndex: input.batch.batchIndex,
                reason,
              }).pipe(Effect.as(BatchOutcome.Unconfirmed({ reason })));
            }
          )
        );

      const ensureReplayWindow = (batch: PersistedBatch) =>
        currentInstant.pipe(
          Effect.filterOrFail(
            (now) =>
              now.epochMilliseconds - batch.requestedAt.epochMilliseconds <=
              Duration.toMillis(campaignDeliveryBatchReplayWindow),
            () => new UnreplayableBatch({ reason: "key-expired" })
          ),
          Effect.asVoid
        );

      const replanPersonalizedBatch = Effect.fn(
        "CampaignBatchDelivery.replanPersonalizedBatch"
      )(function* (
        batch: PersistedBatch,
        ineligible: readonly RecipientRequestDenial[]
      ) {
        const { db } = yield* WorkspaceTransaction;
        const [removed] = yield* db
          .delete(emailCampaignDeliveryBatches)
          .where(
            and(
              eq(emailCampaignDeliveryBatches.sendId, batch.sendId),
              eq(
                emailCampaignDeliveryBatches.deliveryAttempt,
                batch.deliveryAttempt
              ),
              eq(emailCampaignDeliveryBatches.batchIndex, batch.batchIndex),
              eq(emailCampaignDeliveryBatches.status, "requested"),
              eq(emailCampaignDeliveryBatches.payloadHash, batch.payloadHash)
            )
          )
          .returning({ batchIndex: emailCampaignDeliveryBatches.batchIndex });
        if (!removed) return yield* incomplete(batch);
        const at = yield* currentInstant;
        for (const { customerId, reason, priorUncertainty } of ineligible) {
          if (reason === "consent-withdrawn" && !priorUncertainty) {
            yield* markSkipped({
              sendId: batch.sendId,
              skipped: [{ dotyposCustomerId: customerId, reason }],
              at,
            });
          } else {
            yield* settlePendingRecipients({
              sendId: batch.sendId,
              customerIds: [customerId],
              status: priorUncertainty ? "unconfirmed" : "failed",
              failureCode: reason,
              at,
            });
          }
        }
        yield* offerOutcome({
          sendId: batch.sendId,
          customerIds: ineligible.map(({ customerId }) => customerId),
          outcome: "definitively-unsent",
        });
      });

      const requestPersonalized = Effect.fn(
        "CampaignBatchDelivery.requestPersonalized"
      )(function* (
        batch: PersistedBatch,
        mode: BatchRequestMode,
        personalized: PersonalizedBatchRequest,
        messages: readonly EmailMessage[],
        request: (
          beforeRequest: NonNullable<EmailBatchOptions["beforeRequest"]>
        ) => Effect.Effect<BatchOutcome, EmailSendError>
      ) {
        const publication = personalized.send.campaign.publication;
        if (!publication) return yield* incomplete(batch);
        const gate = yield* Semaphore.make(1);
        type Decision =
          | "unrequested"
          | "admitted"
          | Extract<BatchOutcome, { _tag: "Replanned" | "Unconfirmed" }>;
        const state = yield* Ref.make<
          Result.Result<
            Decision,
            CampaignDeliveryIncomplete | DatabaseQueryError
          >
        >(Result.succeed("unrequested"));
        const denialMessage = "Campaign offer request admission failed";
        const denied = new EmailServiceError(denialMessage);
        const beforeRequest: NonNullable<EmailBatchOptions["beforeRequest"]> = (
          _fingerprint,
          requestPositions
        ) =>
          gate.withPermit(
            Effect.gen(function* () {
              const result = yield* Ref.get(state);
              if (Result.isFailure(result)) return yield* denied;
              const previous = result.success;
              if (previous !== "unrequested" && previous !== "admitted")
                return yield* denied;
              const canReplan = mode === "first" && previous === "unrequested";
              // Before any request, validate the whole persisted batch. Once
              // dispatch starts, check only the recipients this request can reach.
              const positions =
                previous === "unrequested"
                  ? [...batch.dotyposCustomerIds.keys()]
                  : requestPositions;
              const customerIds = positions.map(
                (position) => batch.dotyposCustomerIds[position]
              );
              if (
                !customerIds.length ||
                !customerIds.every((id) => id !== undefined)
              )
                return yield* denied;
              const identities =
                yield* analyticsIdentity.forRecipients(customerIds);
              const eligibility = readCampaignOfferEligibility(db, {
                sendId: batch.sendId,
                versionId: publication.versionId,
                customerIds,
              });
              const decision = yield* Effect.result(
                personalized.withLease(
                  Effect.gen(function* () {
                    const byId = new Map(
                      (yield* eligibility).map((row) => [row.customerId, row])
                    );
                    const ineligible = customerIds.flatMap(
                      (customerId, index): RecipientRequestDenial[] => {
                        const row = byId.get(customerId);
                        const position = positions[index];
                        let reason:
                          | RecipientRequestDenial["reason"]
                          | undefined;
                        if (row?.consenting === false)
                          reason = "consent-withdrawn";
                        else if (!row?.requestable)
                          reason = "offer-unavailable";
                        else if (
                          identities.get(customerId) !==
                          (position === undefined
                            ? undefined
                            : messages[position]?.recipientIdentity)
                        )
                          reason = "recipient-payload-changed";
                        if (!reason) return [];
                        return [
                          {
                            customerId,
                            reason,
                            priorUncertainty:
                              row?.deliveryOutcome === "uncertain",
                          },
                        ];
                      }
                    );
                    if (ineligible.length === 0) return "admitted" as const;
                    if (canReplan) {
                      yield* replanPersonalizedBatch(batch, ineligible);
                      return BatchOutcome.Replanned();
                    }
                    return previous === "admitted"
                      ? ({
                          _tag: "Denied",
                          positions: ineligible.map(({ customerId }) =>
                            customerIds.indexOf(customerId)
                          ),
                        } as const)
                      : BatchOutcome.Unconfirmed({ reason: "payload-changed" });
                  })
                )
              );
              if (Result.isFailure(decision)) {
                yield* Ref.set(state, Result.fail(decision.failure));
                return yield* denied;
              }
              const verdict = decision.success;
              if (verdict !== "admitted" && verdict._tag === "Denied")
                return yield* new EmailServiceError(
                  denialMessage,
                  undefined,
                  undefined,
                  { deniedPositions: verdict.positions }
                );
              yield* Ref.set(state, Result.succeed(verdict));
              if (verdict !== "admitted") return yield* denied;
            })
          );
        const result = yield* Effect.result(request(beforeRequest));
        const admission = yield* Effect.fromResult(yield* Ref.get(state));
        if (admission !== "unrequested" && admission !== "admitted")
          return admission;
        return yield* Effect.fromResult(result);
      });

      const renderPersonalizedReplay = (
        send: DeliveredAttempt,
        publication: FrozenCampaignEmail,
        recipients: readonly ReachableRecipient[]
      ) =>
        Effect.forEach(recipients, (recipient) =>
          readCampaignRecipientContent(db, {
            ...publication,
            sendId: send.sendId,
            ...recipient,
            templateKey: send.campaign.templateKey,
          }).pipe(
            Effect.provideService(EmailPersistence, emailPersistence),
            Effect.provideService(
              EmailRecipientPersistence,
              recipientPersistence
            ),
            Effect.catchTags({
              EmailPreparationConflict: () => Effect.fail(payloadChanged()),
              EmailVersionInvalid: () => Effect.fail(payloadChanged()),
            }),
            Effect.filterOrFail(
              (content) => content !== undefined,
              payloadChanged
            ),
            Effect.flatMap((personalizedContent) =>
              renderMessage({ send, recipient, personalizedContent })
            )
          )
        );

      /**
       * Re-renders a requested batch for its request. Its payload must hash
       * the same: every recipient still reachable at the same address, and
       * the same rendering.
       */
      const reproducePayload = (input: {
        readonly send: DeliveredAttempt;
        readonly batch: PersistedBatch;
        /** The batch was persisted from these profiles. */
        readonly profiles: Option.Option<BatchProfiles>;
        readonly payloadHash: string;
        readonly recheckConsent: boolean;
      }) =>
        loadBatchRecipients(input.batch).pipe(
          Effect.filterOrFail(
            (recipients) =>
              recipients.length === input.batch.dotyposCustomerIds.length,
            payloadChanged
          ),
          Effect.flatMap((recipients) =>
            Option.match(input.profiles, {
              onNone: () => hydrate({ send: input.send, recipients }),
              onSome: (profiles) =>
                (input.recheckConsent
                  ? loadConsenting({
                      campaign: input.send.campaign,
                      customerIds: input.batch.dotyposCustomerIds,
                    })
                  : Effect.succeed(new Set(input.batch.dotyposCustomerIds))
                ).pipe(
                  Effect.map((consenting) =>
                    classifyRecipients({ recipients, profiles, consenting })
                  )
                ),
            })
          ),
          Effect.flatMap((hydrated) =>
            Effect.fromResult(Result.all(hydrated)).pipe(
              Effect.mapError(
                ({ reason: skipReason }) =>
                  new UnreplayableBatch({
                    reason: "payload-changed",
                    skipReason,
                  })
              )
            )
          ),
          Effect.flatMap((recipients) => {
            const rendering = { send: input.send, recipients };
            const matches = (messages: readonly EmailMessage[]) =>
              campaignDeliveryPayloadHash(messages) === input.payloadHash;
            if (input.send.campaign.publication)
              return renderPersonalizedReplay(
                input.send,
                input.send.campaign.publication,
                recipients
              );
            return renderMessages(rendering).pipe(
              Effect.filterOrFail(matches, payloadChanged),
              Effect.catchTag("UnreplayableBatch", (error) =>
                Option.match(input.profiles, {
                  // A batch requested before the header gained artwork may
                  // still match when rendered with the original plain header.
                  onNone: () =>
                    renderMessages({
                      ...rendering,
                      showHeaderArtwork: false,
                    }).pipe(Effect.filterOrFail(matches, payloadChanged)),
                  onSome: () => Effect.fail(error),
                })
              )
            );
          }),
          // Rendering fails the same way every time, so the payload can't
          // be reproduced.
          Effect.catchTag("EmailServiceError", () =>
            Effect.fail(payloadChanged())
          ),
          // The batch may have been delivered, so it waits for a replay.
          Effect.catchTags({
            DotyposUnavailable: () => incomplete(input.batch),
            DotyposRejected: () => incomplete(input.batch),
            WorkspaceUrlConfigError: () => incomplete(input.batch),
          })
        );

      /**
       * The batch's emails as requested now: each names its recipient's
       * PostHog person while the recipient's analytics consent allows it. The
       * person is read at each request and isn't part of the persisted
       * payload, so a replay names whom consent allows then.
       */
      const withRecipientIdentities = (
        input: {
          readonly batch: PersistedBatch;
          readonly messages: readonly EmailMessage[];
        },
        guarded = false
      ) =>
        (guarded
          ? analyticsIdentity
              .forGuardedRecipients(input.batch.dotyposCustomerIds)
              .pipe(Effect.catch(() => incomplete(input.batch)))
          : analyticsIdentity.forRecipients(input.batch.dotyposCustomerIds)
        ).pipe(
          Effect.map((identities) =>
            messagesWithIdentities(
              input.messages,
              input.batch.dotyposCustomerIds,
              identities
            )
          )
        );

      const messagesWithIdentities = (
        messages: readonly EmailMessage[],
        customerIds: readonly DotyposCustomerId[],
        identities: Effect.Success<
          ReturnType<typeof analyticsIdentity.forRecipients>
        >
      ) =>
        Arr.zipWith(
          messages,
          customerIds,
          (message, customerId): EmailMessage => {
            const recipientIdentity = identities.get(customerId);
            return recipientIdentity === undefined
              ? message
              : { ...message, recipientIdentity };
          }
        );

      const checkGuardedRecipientIdentity = Effect.fn(
        "CampaignBatchDelivery.checkGuardedRecipientIdentity"
      )(function* (
        input: {
          readonly batch: PersistedBatch;
          readonly messages: readonly EmailMessage[];
        },
        prepared: readonly EmailMessage[],
        admission: BatchRequestAdmission
      ) {
        const eligibility = yield* admission.guard;
        if (eligibility !== true) return eligibility;

        const current = yield* withRecipientIdentities(input, true);
        return current.every(
          (message, index) =>
            message.recipientIdentity === prepared[index]?.recipientIdentity
        )
          ? (true as const)
          : { failureCode: admission.failureCodeOnStalePayload };
      });

      /**
       * Sends a persisted batch under its key, once. An unknown outcome
       * fails, leaving the batch `requested` for a replay.
       */
      const sendBatch = Effect.fn("CampaignBatchDelivery.sendBatch")(
        function* (input: {
          readonly batch: PersistedBatch;
          readonly messages: readonly EmailMessage[];
          readonly request: BatchRequestMode;
          readonly admission?: BatchRequestAdmission | undefined;
          readonly personalized?: PersonalizedBatchRequest | undefined;
        }) {
          const { admission, personalized } = input;
          const request = (
            messages: readonly EmailMessage[],
            beforeRequest?: EmailBatchOptions["beforeRequest"]
          ) =>
            email
              .sendBatch(messages, {
                ...(beforeRequest && { beforeRequest }),
                ...(personalized &&
                  input.request === "first" && {
                    allowFallbackWithAdmission: true,
                  }),
                idempotencyKey: campaignDeliveryBatchIdempotencyKey(
                  input.batch
                ),
                // A repeat stays with the provider that may have taken the
                // earlier request, so no other provider mails it again.
                replay: input.request === "replay",
              })
              .pipe(
                Effect.map((results) =>
                  BatchOutcome.Accepted({
                    recipients: results.map((result) =>
                      recipientOutcome(
                        result,
                        personalized ? "replay" : input.request
                      )
                    ),
                  })
                ),
                Effect.tap(({ recipients }) =>
                  logUnsentEmails(unsentEmails(recipients))
                )
              );
          const payload: Effect.Effect<
            readonly EmailMessage[],
            CampaignDeliveryIncomplete
          > =
            personalized && input.request === "first"
              ? Effect.succeed(input.messages)
              : withRecipientIdentities(input, admission !== undefined);
          return yield* payload.pipe(
            Effect.flatMap(
              Effect.fnUntraced(function* (messages) {
                if (personalized) {
                  if (
                    campaignDeliveryPayloadHash(messages) !==
                    input.batch.payloadHash
                  )
                    return yield* payloadChanged();
                  return yield* requestPersonalized(
                    input.batch,
                    input.request,
                    personalized,
                    messages,
                    (beforeRequest) => request(messages, beforeRequest)
                  );
                }
                return yield* admission
                  ? requestGuardedBatch({
                      batch: input.batch,
                      mode: input.request,
                      guard: checkGuardedRecipientIdentity(
                        input,
                        messages,
                        admission
                      ),
                      pin: (fingerprint) =>
                        pinProviderRequest({
                          batch: input.batch,
                          mode: input.request,
                          claim: admission.claim,
                          preparedHash: admission.preparedHash,
                          fingerprint,
                        }),
                      request: (beforeRequest) =>
                        request(messages, beforeRequest),
                    })
                  : request(messages);
              })
            ),
            Effect.catchTags({
              UnreplayableBatch: ({ reason }) =>
                input.request === "first"
                  ? Effect.succeed(
                      BatchOutcome.Refused({
                        request: "first",
                        failureCode: "payload-changed-before-request",
                        definitivelyUnsent: true,
                      })
                    )
                  : Effect.succeed(BatchOutcome.Unconfirmed({ reason })),
              EmailServiceError: (error) =>
                Effect.logError("Campaign delivery batch refused", {
                  replay: input.request === "replay",
                }).pipe(
                  Effect.as(
                    BatchOutcome.Refused({
                      request: input.request,
                      failureCode: error.code,
                      ...(personalized &&
                        error.definitivelyUnsent && {
                          definitivelyUnsent: true,
                        }),
                    })
                  )
                ),
              NetworkError: () =>
                Effect.logWarning(
                  "Campaign delivery batch outcome unknown; it will be replayed"
                ).pipe(Effect.andThen(incomplete(input.batch))),
            }),
            Effect.annotateLogs({
              batchIndex: input.batch.batchIndex,
              batchSize: input.batch.dotyposCustomerIds.length,
            })
          );
        }
      );

      /**
       * The second digest pins the provider's request, including data the
       * campaign message hash omits, such as a PostHog recipient identity.
       * Only the current automation claim can admit it. A replay with no
       * recorded admission can't prove which provider request would repeat.
       */
      const pinProviderRequest = Effect.fn(
        "CampaignBatchDelivery.pinProviderRequest"
      )(function* (input: {
        readonly batch: PersistedBatch;
        readonly mode: BatchRequestMode;
        readonly claim: BatchRequestClaim;
        readonly preparedHash: string;
        readonly fingerprint: string;
      }) {
        const { batch, claim, fingerprint, mode } = input;
        const prepared = `${guardedPayloadPrefix}${input.preparedHash}`;
        const pinned = `${prepared}:${fingerprint}`;
        const acceptedHashes = mode === "first" ? [prepared, pinned] : [pinned];
        if (!acceptedHashes.includes(batch.payloadHash)) return false;

        const now = yield* currentInstant;
        const [admitted] = yield* db
          .update(emailCampaignDeliveryBatches)
          .set({ payloadHash: pinned })
          .where(
            and(
              eq(emailCampaignDeliveryBatches.sendId, batch.sendId),
              eq(
                emailCampaignDeliveryBatches.deliveryAttempt,
                batch.deliveryAttempt
              ),
              eq(emailCampaignDeliveryBatches.batchIndex, batch.batchIndex),
              eq(emailCampaignDeliveryBatches.status, "requested"),
              inArray(emailCampaignDeliveryBatches.payloadHash, acceptedHashes),
              exists(
                db
                  .select({ id: emailCampaignAutomationWorkUnits.id })
                  .from(emailCampaignAutomationWorkUnits)
                  .where(
                    and(
                      eq(emailCampaignAutomationWorkUnits.id, claim.unitId),
                      eq(
                        emailCampaignAutomationWorkUnits.claimId,
                        claim.claimId
                      ),
                      eq(emailCampaignAutomationWorkUnits.sendId, batch.sendId),
                      eq(emailCampaignAutomationWorkUnits.status, "claimed"),
                      gt(emailCampaignAutomationWorkUnits.claimExpiresAt, now)
                    )
                  )
              )
            )
          )
          .returning({ batchIndex: emailCampaignDeliveryBatches.batchIndex });
        return admitted !== undefined;
      });

      const settle: ICampaignBatchDelivery["settle"] = Effect.fn(
        "CampaignBatchDelivery.settle"
      )(function* (input) {
        const { outcome } = input;
        if (outcome._tag === "Replanned") return;
        const settled = { ...input, outcome };
        yield* recordBatchStatus(settled);
        if (!input.personalized) {
          yield* recordRecipientsOutcome(settled);
          return;
        }
        yield* settlePersonalization(input);
      });

      const settlePersonalization = Effect.fn(
        "CampaignBatchDelivery.settlePersonalization"
      )(function* (input: {
        readonly batch: PersistedBatch;
        readonly outcome: BatchOutcome;
        readonly at: Temporal.Instant;
      }) {
        const { batch, outcome } = input;
        if (outcome._tag === "Accepted") {
          yield* settleRecipients({ ...input, recipients: outcome.recipients });
          const outcomes = Arr.zip(
            batch.dotyposCustomerIds,
            outcome.recipients
          );
          yield* offerOutcome({
            sendId: batch.sendId,
            customerIds: outcomes
              .filter(([, result]) => result.status === "sent")
              .map(([id]) => id),
            outcome: "accepted",
          });
          yield* offerOutcome({
            sendId: batch.sendId,
            customerIds: outcomes
              .filter(([, result]) => result.status !== "sent")
              .map(([id]) => id),
            outcome: "uncertain",
          });
          return;
        }
        const definitive =
          outcome._tag === "Refused" &&
          outcome.request === "first" &&
          outcome.definitivelyUnsent;
        // A manual retry may contain preparations whose earlier delivery stayed uncertain.
        const previous = yield* db
          .select({ id: emailPreparations.dotyposCustomerId })
          .from(emailPreparations)
          .where(
            and(
              eq(emailPreparations.sendId, batch.sendId),
              inArray(emailPreparations.dotyposCustomerId, [
                ...batch.dotyposCustomerIds,
              ]),
              eq(emailPreparations.deliveryOutcome, "uncertain")
            )
          );
        const uncertain = new Set(previous.map(({ id }) => id));
        const noSend = definitive
          ? batch.dotyposCustomerIds.filter((id) => !uncertain.has(id))
          : [];
        const unclear = definitive
          ? batch.dotyposCustomerIds.filter((id) => uncertain.has(id))
          : batch.dotyposCustomerIds;
        for (const [customerIds, status, deliveryOutcome] of [
          [noSend, "failed", "definitively-unsent"],
          [unclear, "unconfirmed", "uncertain"],
        ] as const) {
          if (customerIds.length === 0) continue;
          yield* settlePendingRecipients({
            sendId: batch.sendId,
            customerIds,
            status,
            at: input.at,
            failureCode:
              outcome._tag === "Refused" ? outcome.failureCode : undefined,
          });
          yield* offerOutcome({
            sendId: batch.sendId,
            customerIds,
            outcome: deliveryOutcome,
          });
        }
      });

      const recordBatchStatus = (input: {
        readonly batch: PersistedBatch;
        readonly outcome: SettledBatchOutcome;
        readonly at: Temporal.Instant;
        readonly personalized?: boolean;
      }) =>
        db
          .update(emailCampaignDeliveryBatches)
          .set({
            status:
              input.personalized &&
              input.outcome._tag === "Refused" &&
              !input.outcome.definitivelyUnsent
                ? "unconfirmed"
                : batchStatusOf(input.outcome),
            settledAt: input.at,
          })
          .where(
            and(
              eq(emailCampaignDeliveryBatches.sendId, input.batch.sendId),
              eq(
                emailCampaignDeliveryBatches.deliveryAttempt,
                input.batch.deliveryAttempt
              ),
              eq(
                emailCampaignDeliveryBatches.batchIndex,
                input.batch.batchIndex
              )
            )
          );

      /** Moves a settled batch's recipients to what its outcome means. */
      const recordRecipientsOutcome = (input: {
        readonly batch: PersistedBatch;
        readonly outcome: SettledBatchOutcome;
        readonly at: Temporal.Instant;
      }): Effect.Effect<void, DatabaseQueryError> =>
        Match.value(input.outcome).pipe(
          Match.tagsExhaustive({
            Accepted: ({ recipients }) =>
              settleRecipients({ ...input, recipients }),
            Skipped: ({ reason }) =>
              markSkipped({
                sendId: input.batch.sendId,
                at: input.at,
                skipped: input.batch.dotyposCustomerIds.map(
                  (dotyposCustomerId) => ({
                    dotyposCustomerId,
                    reason,
                  })
                ),
              }).pipe(Effect.asVoid),
            Refused: ({ request: refused, failureCode }) =>
              settleBatchRecipients({
                ...input,
                status: refused === "first" ? "failed" : "unconfirmed",
                failureCode,
              }),
            Unconfirmed: () =>
              settleBatchRecipients({ ...input, status: "unconfirmed" }),
          })
        );

      const settleBatchRecipients = (input: {
        readonly batch: PersistedBatch;
        readonly status: "failed" | "unconfirmed";
        readonly failureCode?: string | undefined;
        readonly at: Temporal.Instant;
      }) =>
        settlePendingRecipients({
          sendId: input.batch.sendId,
          customerIds: input.batch.dotyposCustomerIds,
          status: input.status,
          failureCode: input.failureCode,
          at: input.at,
        }).pipe(Effect.asVoid);

      /**
       * Records the provider's message ID of a recipient's accepted email. It
       * wins over any failure recorded for the recipient; a webhook that
       * arrived first may already have moved it past `sent`, and that status
       * stays.
       */
      const markSent = (input: {
        readonly sendId: CampaignSendId;
        readonly dotyposCustomerId: DotyposCustomerId;
        readonly providerMessageId: string;
        readonly at: Temporal.Instant;
      }) =>
        db
          .update(emailCampaignRecipients)
          .set({
            providerMessageId: input.providerMessageId,
            status: sql`case when ${inArray(emailCampaignRecipients.status, undeliveredRecipientStatuses)} then 'sent' else ${emailCampaignRecipients.status} end`,
            failureCode: null,
            statusUpdatedAt: input.at,
          })
          .where(
            and(
              eq(emailCampaignRecipients.sendId, input.sendId),
              eq(
                emailCampaignRecipients.dotyposCustomerId,
                input.dotyposCustomerId
              )
            )
          );

      /** Moves each recipient of an accepted batch to its email's outcome. */
      const settleRecipients = (input: {
        readonly batch: PersistedBatch;
        readonly recipients: readonly RecipientOutcome[];
        readonly at: Temporal.Instant;
      }) =>
        Effect.forEach(
          Arr.zip(input.batch.dotyposCustomerIds, input.recipients),
          ([dotyposCustomerId, outcome]) =>
            outcome.status === "sent"
              ? markSent({
                  sendId: input.batch.sendId,
                  dotyposCustomerId,
                  providerMessageId: outcome.providerMessageId,
                  at: input.at,
                })
              : settlePendingRecipients({
                  sendId: input.batch.sendId,
                  customerIds: [dotyposCustomerId],
                  status: outcome.status,
                  failureCode: outcome.failureCode,
                  at: input.at,
                }),
          { discard: true }
        );

      return {
        prepare,
        persist,
        failUnrequested,
        listRequested,
        request,
        settle,
      } satisfies ICampaignBatchDelivery;
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        CampaignEmailConfig.Default,
        CampaignUnsubscribeService.Live,
        campaignOfferPreparationLayers(CustomerValues.DeliveryLive),
        CampaignRecipientAnalyticsIdentity.Default.pipe(
          Layer.provide(AnalyticsConsentLedger.Default)
        ),
        WorkspaceDotyposLayer,
        WorkspaceEmailLayer
      )
    ),
    Layer.provide(WorkspaceDatabase.Default)
  );
}

const guardedPayloadPrefix = "guarded-v1:";

/**
 * The guard runs again for provider retries. Once any attempt
 * was admitted, a later denial cannot prove the message was never sent.
 */
const requestGuardedBatch = Effect.fn("CampaignBatchDelivery.requestGuarded")(
  function* (input: {
    readonly batch: PersistedBatch;
    readonly mode: BatchRequestMode;
    readonly guard: BatchRequestGuard;
    readonly pin: (
      fingerprint: string
    ) => Effect.Effect<boolean, DatabaseQueryError>;
    readonly request: (
      beforeRequest: NonNullable<EmailBatchOptions["beforeRequest"]>
    ) => Effect.Effect<BatchOutcome, EmailSendError>;
  }) {
    const admitted = yield* Ref.make(false);
    const denial = yield* Ref.make<
      | Result.Result<
          BatchOutcome,
          CampaignDeliveryIncomplete | DatabaseQueryError
        >
      | undefined
    >(undefined);
    const beforeRequest = Effect.fn(
      "CampaignBatchDelivery.beforeProviderRequest"
    )(
      function* (fingerprint: string) {
        const verdict = yield* Effect.result(
          Effect.gen(function* () {
            const current = yield* input.guard;
            if (current !== true) return current;
            const pinned = yield* input.pin(fingerprint);
            return pinned ? (true as const) : ("request-changed" as const);
          })
        );
        if (Result.isFailure(verdict)) {
          yield* Ref.set(denial, Result.fail(verdict.failure));
        } else if (verdict.success === true) {
          yield* Ref.set(admitted, true);
          return;
        } else if (verdict.success === "request-changed") {
          yield* Ref.set(
            denial,
            Result.succeed(
              BatchOutcome.Unconfirmed({ reason: "payload-changed" })
            )
          );
        } else {
          const attempted = yield* Ref.get(admitted);
          const refusal =
            "skipReason" in verdict.success
              ? BatchOutcome.Skipped({ reason: verdict.success.skipReason })
              : BatchOutcome.Refused({
                  request: "first",
                  failureCode: verdict.success.failureCode,
                });
          const outcome =
            input.mode === "replay" || attempted
              ? BatchOutcome.Unconfirmed({ reason: "payload-changed" })
              : refusal;
          yield* Ref.set(denial, Result.succeed(outcome));
        }
        return yield* new EmailServiceError("Email request admission failed");
      },
      (effect) =>
        effect.pipe(
          Effect.onInterrupt(() =>
            Ref.set(
              denial,
              Result.fail(
                new CampaignDeliveryIncomplete({
                  sendId: input.batch.sendId,
                  deliveryAttempt: input.batch.deliveryAttempt,
                })
              )
            )
          )
        )
    );
    const outcome = yield* Effect.result(input.request(beforeRequest));
    const denied = yield* Ref.get(denial);
    if (denied !== undefined) return yield* Effect.fromResult(denied);
    return yield* Effect.fromResult(outcome);
  }
);

/** The batch status each outcome settles as. */
const batchStatusOf = Match.type<SettledBatchOutcome>().pipe(
  Match.tagsExhaustive({
    Accepted: () => "accepted" as const,
    Skipped: () => "rejected" as const,
    Refused: ({ request }) =>
      request === "first" ? ("rejected" as const) : ("unconfirmed" as const),
    Unconfirmed: () => "unconfirmed" as const,
  })
);

/** The emails of an accepted batch that weren't sent, by error code. */
const unsentEmails = (recipients: readonly RecipientOutcome[]) => ({
  failed: recipients.flatMap((outcome) =>
    outcome.status === "failed" ? [outcome.failureCode ?? "unknown"] : []
  ),
  unconfirmed: recipients.flatMap((outcome) =>
    outcome.status === "unconfirmed" ? [outcome.failureCode ?? "unknown"] : []
  ),
});

const logUnsentEmails = (unsent: ReturnType<typeof unsentEmails>) =>
  Effect.logWarning(
    "Campaign delivery batch had emails that weren't sent",
    unsent
  ).pipe(
    Effect.when(
      Effect.succeed(unsent.failed.length > 0 || unsent.unconfirmed.length > 0)
    )
  );

/**
 * An email's outcome from its result. An email no provider answered may
 * have been delivered, and so may one refused during a replay, since the
 * refusal says nothing about the earlier request.
 */
const recipientOutcome = (
  result: EmailBatchResult,
  request: "first" | "replay"
): RecipientOutcome =>
  result.status === "failed"
    ? Match.value(result.error).pipe(
        Match.tag(
          "NetworkError",
          (error): RecipientOutcome => ({
            status: "unconfirmed",
            failureCode: error.code,
          })
        ),
        Match.tag(
          "EmailServiceError",
          (error): RecipientOutcome => ({
            status: request === "replay" ? "unconfirmed" : "failed",
            failureCode: error.code,
          })
        ),
        Match.exhaustive
      )
    : { status: "sent", providerMessageId: result.id };

const unrendered = (input: {
  readonly send: DeliveredAttempt;
  readonly skipped: readonly SkippedRecipient[];
  readonly reachable: readonly ReachableRecipient[];
  readonly cause: { readonly _tag: string };
}) => Effect.succeed(PreparedBatch.Unrendered(input));

const payloadChanged = () =>
  new UnreplayableBatch({ reason: "payload-changed" });

const incomplete = (attempt: CampaignDeliveryAttempt) =>
  Effect.fail(
    new CampaignDeliveryIncomplete({
      sendId: attempt.sendId,
      deliveryAttempt: attempt.deliveryAttempt,
    })
  );
