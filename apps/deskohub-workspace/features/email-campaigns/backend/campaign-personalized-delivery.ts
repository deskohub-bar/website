import "server-only";

import type { DotyposCustomerId } from "@deskohub/dotypos";
import type { EmailId, EmailVersionId } from "@deskohub/workspace-admin-api";
import { and, eq, exists, inArray, notExists, sql } from "drizzle-orm";
import { Effect, Layer, Result } from "effect";
import {
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import { discountCodes, emailCampaignRecipients } from "@/db/schema";
import {
  type EmailDeliveryOutcome,
  emailDiscountIssuances,
  emailPreparations,
} from "@/db/schema/emails";
import {
  EmailPersistence,
  EmailRecipientPersistence,
} from "@/features/emails/backend";
import { renderEmailContent } from "@/features/emails/body/email-content";
import type { CustomerValues } from "@/features/emails/values/customer";
import { EmailDiscountValues } from "@/features/emails/values/discount";
import { EmailRecipientPreparation } from "@/features/emails/values/preparation";
import type { Locale } from "@/features/i18n";
import { marketingConsentState } from "@/features/legal/backend/marketing-consent-ledger";
import type { CampaignTemplateKey } from "../body/campaign-content";
import type { CampaignSendId } from "../campaign-identifiers";

export type FrozenCampaignEmail = {
  readonly emailId: EmailId;
  readonly versionId: EmailVersionId;
};

type PersonalizationRecipient = FrozenCampaignEmail & {
  readonly sendId: CampaignSendId;
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly locale: Locale;
};

const recipientPreparation = (input: PersonalizationRecipient) =>
  and(
    eq(emailPreparations.sendId, input.sendId),
    eq(emailPreparations.dotyposCustomerId, input.dotyposCustomerId),
    eq(emailPreparations.emailVersionId, input.versionId),
    eq(emailPreparations.locale, input.locale)
  );

/** A ready snapshot may outlive a code an operator disabled. */
const activeRecipientOffer = (db: WorkspaceDatabaseClient) =>
  notExists(
    db
      .select({ name: emailDiscountIssuances.valueName })
      .from(emailDiscountIssuances)
      .where(
        and(
          eq(emailDiscountIssuances.preparationId, emailPreparations.id),
          notExists(
            db
              .select({ id: discountCodes.id })
              .from(discountCodes)
              .where(
                and(
                  eq(discountCodes.code, emailDiscountIssuances.code),
                  eq(emailDiscountIssuances.state, "issued"),
                  eq(discountCodes.enabled, true)
                )
              )
          )
        )
      )
  );

const requestableOffer = (db: WorkspaceDatabaseClient) =>
  and(
    eq(emailPreparations.state, "ready"),
    inArray(emailPreparations.deliveryOutcome, ["delivering", "uncertain"]),
    activeRecipientOffer(db)
  );

/** Reads current consent and code availability in the same database snapshot. */
export const readCampaignOfferEligibility = (
  db: WorkspaceDatabaseClient,
  input: {
    readonly sendId: CampaignSendId;
    readonly versionId: EmailVersionId;
    readonly customerIds: readonly DotyposCustomerId[];
  }
) =>
  db
    .select({
      customerId: emailPreparations.dotyposCustomerId,
      consenting: sql<boolean>`${marketingConsentState(emailPreparations.dotyposCustomerId)} = 'active'`,
      requestable: sql<boolean>`${requestableOffer(db)}`,
      deliveryOutcome: emailPreparations.deliveryOutcome,
    })
    .from(emailPreparations)
    .where(
      and(
        eq(emailPreparations.sendId, input.sendId),
        eq(emailPreparations.emailVersionId, input.versionId),
        inArray(emailPreparations.dotyposCustomerId, [...input.customerIds])
      )
    );

/** A replay reads saved values. It never prepares or generates them again. */
export const readCampaignRecipientContent = Effect.fn(
  "readCampaignRecipientContent"
)(function* (
  db: WorkspaceDatabaseClient,
  input: PersonalizationRecipient & {
    readonly templateKey: CampaignTemplateKey;
  }
) {
  const [preparation] = yield* db
    .select({ id: emailPreparations.id })
    .from(emailPreparations)
    .where(and(recipientPreparation(input), requestableOffer(db)));
  if (!preparation) return undefined;
  const emails = yield* EmailPersistence;
  const preparations = yield* EmailRecipientPersistence;
  const version = yield* emails.getVersion(input.versionId);
  if (
    !version ||
    version.emailId !== input.emailId ||
    version.document.purpose !== "marketing" ||
    version.document.templateKey !== input.templateKey
  )
    return undefined;
  const snapshots = yield* preparations.readSnapshots(preparation.id);
  return Result.getOrUndefined(
    renderEmailContent({
      document: version.document,
      locale: input.locale,
      values: Object.fromEntries(
        snapshots.map(({ valueName, value }) => [valueName, value])
      ),
    })
  );
});

/**
 * Records only monotonic delivery evidence. A previous uncertain request
 * permanently rules out definitive no-send for this preparation.
 */
export const recordCampaignOfferOutcome = Effect.fn(
  "recordCampaignOfferOutcome"
)(function* (input: {
  readonly sendId: CampaignSendId;
  readonly customerIds: readonly DotyposCustomerId[];
  readonly outcome: Exclude<EmailDeliveryOutcome, "pending">;
}) {
  if (input.customerIds.length === 0) return;
  const { db } = yield* WorkspaceTransaction;
  const discounts = yield* EmailDiscountValues;
  const previous = {
    delivering: ["pending"],
    accepted: ["delivering", "uncertain"],
    uncertain: ["delivering"],
    "definitively-unsent": ["pending", "delivering"],
  } satisfies Record<typeof input.outcome, EmailDeliveryOutcome[]>;
  const updated = yield* db
    .update(emailPreparations)
    .set({ deliveryOutcome: input.outcome })
    .where(
      and(
        eq(emailPreparations.sendId, input.sendId),
        inArray(emailPreparations.dotyposCustomerId, [...input.customerIds]),
        inArray(emailPreparations.deliveryOutcome, previous[input.outcome]),
        input.outcome === "definitively-unsent"
          ? exists(
              db
                .select({ id: emailCampaignRecipients.sendId })
                .from(emailCampaignRecipients)
                .where(
                  and(
                    eq(
                      emailCampaignRecipients.sendId,
                      emailPreparations.sendId
                    ),
                    eq(
                      emailCampaignRecipients.dotyposCustomerId,
                      emailPreparations.dotyposCustomerId
                    ),
                    inArray(emailCampaignRecipients.status, [
                      "failed",
                      "skipped",
                    ])
                  )
                )
            )
          : undefined
      )
    )
    .returning({ id: emailPreparations.id });
  if (input.outcome === "definitively-unsent") {
    yield* Effect.forEach(
      updated,
      ({ id }) =>
        discounts
          .disableUnsent(id)
          .pipe(
            Effect.catchTag("EmailDiscountValueUnavailable", (cause) =>
              Effect.die(cause)
            )
          ),
      { discard: true }
    );
  }
});

export const campaignOfferPreparationLayers = <E, R>(
  customers: Layer.Layer<CustomerValues, E, R>
) => {
  const persistence = Layer.mergeAll(
    EmailPersistence.Default,
    EmailRecipientPersistence.Default
  );
  const discounts = EmailDiscountValues.Default.pipe(
    Layer.provide(persistence)
  );
  return Layer.mergeAll(
    persistence,
    discounts,
    EmailRecipientPreparation.Default.pipe(
      Layer.provide(Layer.mergeAll(persistence, discounts, customers))
    )
  );
};
