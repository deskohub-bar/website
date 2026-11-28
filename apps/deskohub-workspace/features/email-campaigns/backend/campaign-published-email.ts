import "server-only";

import { getLocaleDefinition } from "@deskohub/i18n/locale-registry";
import {
  type AutomationTriggerType as AutomationTrigger,
  EmailDocument,
  type EmailId,
  type EmailValueSnapshot,
  type EmailVersionId,
  emailDocumentRequiredTriggers,
  emailDocumentUsesDiscounts,
  referencedEmailValueNames,
  requiredEmailLocale,
  requiredEmailValueNames,
} from "@deskohub/workspace-admin-api";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { Effect, Option, Result, Schema } from "effect";
import {
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import {
  type CampaignRow,
  emailCampaignAutomations,
  emailCampaignAutomationVersions,
  emailCampaignSends,
  emailCampaigns,
} from "@/db/schema";
import { emails, emailVersions } from "@/db/schema/emails";
import { sampleEmailValues } from "@/features/emails/body";
import {
  type RenderedEmailContent,
  renderEmailContent,
} from "@/features/emails/body/email-content";
import {
  type PassReminderTriggerPayload,
  passReminderTriggerSnapshot,
} from "@/features/emails/body/pass-reminder-trigger-values";
import type { Locale } from "@/features/i18n";
import { currentInstant } from "@/shared/utils/temporal";
import { automationTriggerKind } from "../automation/automation-triggers";
import { AutomationFlowInvalid } from "../automation/errors";
import type { CampaignId } from "../campaign-identifiers";
import type { CampaignDelivery } from "../campaign-states";
import { CampaignPublishedEmailInvalid } from "../errors";

const decodePublishedDocument = Schema.decodeUnknownOption(EmailDocument);

export type CampaignEmailPublication = {
  readonly emailId: EmailId;
  readonly title: string;
  readonly versionId: EmailVersionId;
  readonly document: EmailDocument;
};

/** Whether the document's referenced values read customer data. */
const emailDocumentUsesCustomerValues = (document: EmailDocument): boolean => {
  const referenced = referencedEmailValueNames(document);
  return document.values.some(
    (definition) =>
      referenced.has(definition.name) && definition.source.kind === "customer"
  );
};

/** Whether a published email can be attached to a campaign of `delivery`. */
export const isPublishedEmailCompatibleWithDelivery = (
  document: EmailDocument,
  delivery: CampaignDelivery
): boolean => {
  if (document.purpose !== "marketing") return false;
  if (delivery === "once")
    return emailDocumentRequiredTriggers(document).length === 0;
  return (
    !emailDocumentUsesDiscounts(document) &&
    !emailDocumentUsesCustomerValues(document)
  );
};

/** Validates that a published email can be linked to a campaign of `delivery`. */
export const validatePublishedEmailForDelivery = (
  document: EmailDocument,
  delivery: CampaignDelivery
): Effect.Effect<void, CampaignPublishedEmailInvalid> => {
  if (
    delivery === "once" &&
    emailDocumentRequiredTriggers(document).length > 0
  ) {
    return Effect.fail(
      new CampaignPublishedEmailInvalid({ reason: "trigger-required" })
    );
  }
  if (
    delivery === "automated" &&
    (emailDocumentUsesDiscounts(document) ||
      emailDocumentUsesCustomerValues(document))
  ) {
    return Effect.fail(
      new CampaignPublishedEmailInvalid({
        reason: "automated-values-unsupported",
      })
    );
  }
  return Effect.void;
};

/** Validates that a linked published email matches the automation's trigger. */
export const validatePublishedEmailForAutomationTrigger = (
  document: EmailDocument,
  trigger: AutomationTrigger
): Effect.Effect<void, AutomationFlowInvalid> => {
  if (
    emailDocumentUsesDiscounts(document) ||
    emailDocumentUsesCustomerValues(document)
  ) {
    return Effect.fail(
      new AutomationFlowInvalid({
        message:
          "Automated campaigns cannot use emails with customer or discount values yet. Choose another published email.",
      })
    );
  }
  const requiredTriggers = emailDocumentRequiredTriggers(document);
  if (requiredTriggers.length === 0) return Effect.void;
  const flowTriggerKind = automationTriggerKind(trigger);
  const incompatible = requiredTriggers.filter(
    (required) => required !== flowTriggerKind
  );
  if (incompatible.length > 0) {
    return Effect.fail(
      new AutomationFlowInvalid({
        message: `The linked email uses trigger values (${incompatible.join(", ")}) that don't match this automation's ${flowTriggerKind} trigger.`,
      })
    );
  }
  return Effect.void;
};

/** Picks the best published translation for a recipient locale via the fallback chain. */
export const resolveEmailDocumentLocale = (
  document: EmailDocument,
  recipientLocale: Locale
): Locale => {
  const chain = [
    recipientLocale,
    ...getLocaleDefinition(recipientLocale).fallbackChain,
  ];
  for (const candidate of chain) {
    if (Object.hasOwn(document.translations, candidate)) return candidate;
  }
  return requiredEmailLocale;
};

/** Renders an automated campaign's published email for one recipient. */
export const renderAutomatedPublishedEmail = (input: {
  readonly document: EmailDocument;
  readonly recipientLocale: Locale;
  readonly triggerPayload?: PassReminderTriggerPayload;
}): Result.Result<
  { readonly locale: Locale; readonly content: RenderedEmailContent },
  string
> => {
  const locale = resolveEmailDocumentLocale(
    input.document,
    input.recipientLocale
  );
  const required = new Set<string>(requiredEmailValueNames(input.document));
  const values: Record<string, EmailValueSnapshot> = {};
  for (const definition of input.document.values) {
    if (!required.has(definition.name)) continue;
    if (definition.source.kind !== "trigger") {
      return Result.fail(`unsupported-value-source:${definition.source.kind}`);
    }
    if (
      !input.triggerPayload ||
      input.triggerPayload.trigger !== definition.source.trigger
    ) {
      return Result.fail(`trigger-mismatch:${definition.source.trigger}`);
    }
    values[definition.name] = passReminderTriggerSnapshot(
      input.triggerPayload,
      locale
    );
  }
  return renderEmailContent({
    document: input.document,
    locale,
    values,
  }).pipe(
    Result.map((content) => ({ locale, content })),
    Result.mapError((error) => error._tag)
  );
};

export const sampleCampaignEmailContent = Effect.fn(
  "sampleCampaignEmailContent"
)(function* (
  document: EmailDocument,
  locale: Locale,
  options?: { readonly now?: Temporal.Instant }
) {
  const now = options?.now ?? (yield* currentInstant);
  return yield* Effect.fromResult(
    renderEmailContent({
      document,
      locale,
      values: sampleEmailValues(document, locale, now),
    })
  );
});

/** Lists selectable publications without reading customer data. */
export const listCampaignEmailPublications = (db: WorkspaceDatabaseClient) =>
  db
    .selectDistinctOn([emails.id], {
      emailId: emails.id,
      title: emails.title,
      versionId: emailVersions.id,
      document: emailVersions.document,
    })
    .from(emails)
    .innerJoin(emailVersions, eq(emailVersions.emailId, emails.id))
    .where(isNull(emails.archivedAt))
    .orderBy(emails.id, desc(emailVersions.versionNumber))
    .pipe(
      Effect.map((rows) =>
        rows.flatMap((row) =>
          Option.match(decodePublishedDocument(row.document), {
            onNone: () => [],
            onSome: (document) =>
              document.purpose === "marketing" ? [{ ...row, document }] : [],
          })
        )
      )
    );

export const getCampaignEmailPublication = Effect.fn(
  "getCampaignEmailPublication"
)(function* (db: WorkspaceDatabaseClient, emailId: EmailId) {
  const [row] = yield* db
    .select({
      emailId: emails.id,
      title: emails.title,
      archivedAt: emails.archivedAt,
      versionId: emailVersions.id,
      document: emailVersions.document,
    })
    .from(emails)
    .innerJoin(emailVersions, eq(emailVersions.emailId, emails.id))
    .where(eq(emails.id, emailId))
    .orderBy(desc(emailVersions.versionNumber))
    .limit(1);
  if (!row || row.archivedAt !== null) return undefined;
  const document = decodePublishedDocument(row.document);
  if (Option.isNone(document) || document.value.purpose !== "marketing")
    return undefined;
  return { ...row, document: document.value };
});

/** Reads one immutable published email version without requiring EmailPersistence. */
export const getCampaignEmailVersion = Effect.fn("getCampaignEmailVersion")(
  function* (db: WorkspaceDatabaseClient, versionId: EmailVersionId) {
    const [row] = yield* db
      .select({
        emailId: emailVersions.emailId,
        versionId: emailVersions.id,
        document: emailVersions.document,
      })
      .from(emailVersions)
      .where(eq(emailVersions.id, versionId))
      .limit(1);
    if (!row) return undefined;
    const document = decodePublishedDocument(row.document);
    if (Option.isNone(document) || document.value.purpose !== "marketing")
      return undefined;
    return { ...row, document: document.value };
  }
);

/** Publication takes a write lock on the same logical email before inserting a version. */
export const lockCampaignEmailPublication = Effect.fn(
  "lockCampaignEmailPublication"
)(function* (emailId: EmailId) {
  const { db } = yield* WorkspaceTransaction;
  yield* db
    .select({ id: emails.id })
    .from(emails)
    .where(eq(emails.id, emailId))
    .for("share");
  return yield* getCampaignEmailPublication(db, emailId);
});

/**
 * Editable campaigns (one-off drafts and non-archived automations) follow the
 * latest publication; confirmed one-off sends and archived automations use
 * their frozen version.
 */
export const getLinkedCampaignEmails = Effect.fn("getLinkedCampaignEmails")(
  function* (db: WorkspaceDatabaseClient, campaigns: readonly CampaignRow[]) {
    const documents = new Map<
      CampaignId,
      { readonly document: EmailDocument }
    >();
    const linked = campaigns.filter(({ emailId }) => emailId !== null);
    if (linked.length === 0) return documents;

    const onceIds = linked
      .filter(({ delivery }) => delivery === "once")
      .map(({ id }) => id);
    const automatedIds = linked
      .filter(({ delivery }) => delivery === "automated")
      .map(({ id }) => id);

    if (onceIds.length > 0) {
      const rows = yield* db
        .selectDistinctOn([emailCampaigns.id], {
          campaignId: emailCampaigns.id,
          status: emailCampaigns.status,
          templateKey: emailCampaigns.templateKey,
          document: emailVersions.document,
        })
        .from(emailCampaigns)
        .innerJoin(emails, eq(emails.id, emailCampaigns.emailId))
        .leftJoin(
          emailCampaignSends,
          and(
            eq(emailCampaignSends.campaignId, emailCampaigns.id),
            isNull(emailCampaignSends.automationVersionId)
          )
        )
        .innerJoin(
          emailVersions,
          and(
            eq(emailVersions.emailId, emails.id),
            or(
              and(
                eq(emailCampaigns.status, "draft"),
                isNull(emails.archivedAt)
              ),
              and(
                ne(emailCampaigns.status, "draft"),
                eq(emailVersions.id, emailCampaignSends.frozenEmailVersionId)
              )
            )
          )
        )
        .where(
          and(
            inArray(emailCampaigns.id, onceIds),
            eq(emailCampaigns.delivery, "once"),
            eq(emailCampaigns.purpose, "marketing")
          )
        )
        .orderBy(emailCampaigns.id, desc(emailVersions.versionNumber));
      for (const row of rows) {
        const document = Option.getOrUndefined(
          decodePublishedDocument(row.document)
        );
        if (
          document?.purpose === "marketing" &&
          (row.status === "draft" || document.templateKey === row.templateKey)
        )
          documents.set(row.campaignId, { document });
      }
    }

    if (automatedIds.length > 0) {
      const rows = yield* db
        .selectDistinctOn([emailCampaigns.id], {
          campaignId: emailCampaigns.id,
          status: emailCampaigns.status,
          templateKey: emailCampaigns.templateKey,
          document: emailVersions.document,
        })
        .from(emailCampaigns)
        .innerJoin(emails, eq(emails.id, emailCampaigns.emailId))
        .leftJoin(
          emailCampaignAutomations,
          eq(emailCampaignAutomations.campaignId, emailCampaigns.id)
        )
        .leftJoin(
          emailCampaignAutomationVersions,
          eq(
            emailCampaignAutomationVersions.id,
            emailCampaignAutomations.activeVersionId
          )
        )
        .innerJoin(
          emailVersions,
          and(
            eq(emailVersions.emailId, emails.id),
            or(
              and(
                ne(emailCampaigns.status, "archived"),
                isNull(emails.archivedAt)
              ),
              and(
                eq(emailCampaigns.status, "archived"),
                eq(
                  emailVersions.id,
                  emailCampaignAutomationVersions.frozenEmailVersionId
                )
              )
            )
          )
        )
        .where(
          and(
            inArray(emailCampaigns.id, automatedIds),
            eq(emailCampaigns.delivery, "automated"),
            eq(emailCampaigns.purpose, "marketing")
          )
        )
        .orderBy(emailCampaigns.id, desc(emailVersions.versionNumber));
      for (const row of rows) {
        const document = Option.getOrUndefined(
          decodePublishedDocument(row.document)
        );
        if (document?.purpose === "marketing")
          documents.set(row.campaignId, { document });
      }
    }

    return documents;
  }
);

export const getLinkedCampaignEmail = (
  db: WorkspaceDatabaseClient,
  campaign: CampaignRow
) =>
  getLinkedCampaignEmails(db, [campaign]).pipe(
    Effect.map((publications) => publications.get(campaign.id))
  );
