import assert from "node:assert/strict";
import type { DotyposCustomerId } from "@deskohub/dotypos";
import { mapSupportedLocales } from "@deskohub/i18n/locale-registry";
import type {
  AutomationFlowType as AutomationFlow,
  AutomationTriggerType as AutomationTrigger,
  EmailDocument,
  EmailId,
  EmailTriggerEvent,
  EmailVersionId,
} from "@deskohub/workspace-admin-api";
import {
  EmailDocumentForPublication,
  requiredEmailValueNames,
} from "@deskohub/workspace-admin-api";
import { inArray, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceDatabaseClient,
} from "@/db/database.service";
import type { RootDatabaseClient } from "@/db/database-client";
import {
  emailCampaignAutomationCustomerClaims,
  emailCampaignAutomationRuns,
  emailCampaignAutomationScheduleFires,
  emailCampaignAutomations,
  emailCampaignAutomationTriggerReceipts,
  emailCampaignAutomationVersions,
  emailCampaignAutomationWorkUnits,
  emailCampaignRecipients,
  emailCampaignSends,
  emailCampaigns,
  emails,
  emailVersions,
} from "@/db/schema";
import type { Locale } from "@/features/i18n";
import type { AudienceFilter } from "../audience-filter";
import type { AutomationVersionId } from "../automation/automation-identifiers";
import type {
  CampaignLocaleContent,
  CampaignLocalizedContent,
  CampaignPurpose,
} from "../body/campaign-content";
import {
  hashCampaignContent,
  hashCampaignEmailVersion,
} from "../body/campaign-content-hash";
import type {
  CampaignAudienceId,
  CampaignId,
  CampaignSendId,
} from "../campaign-identifiers";
import type {
  automatedCampaignStatuses,
  CampaignRecipientStatus,
  CampaignStatus,
} from "../campaign-states";

export const everyoneFilter: AudienceFilter = {
  _tag: "Group",
  operator: "and",
  filters: [],
};

/** Czech-only campaign content whose body is one paragraph of `text`. */
export const campaignContentFixture = (
  text = "Ahoj"
): CampaignLocalizedContent & { readonly "cs-CZ": CampaignLocaleContent } => ({
  "cs-CZ": {
    subject: "Novinky",
    preheader: "Co je nového",
    body: {
      formatVersion: 1,
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    },
  },
});

/**
 * A flow whose condition step requires customers to be in the saved
 * audience `audienceId`, nested in a group as the builder stores it.
 */
export const audienceConditionFlowFixture = (
  audienceId: CampaignAudienceId
) => ({
  trigger: { _tag: "ReservationBooked" },
  steps: [
    {
      _tag: "Condition",
      id: "step-regulars",
      filter: {
        _tag: "Group",
        operator: "and",
        filters: [{ _tag: "InAudience", audienceId, operator: "in" }],
      },
    },
    { _tag: "Send", id: "step-send" },
  ],
});

type SeededRecipient = {
  readonly dotyposCustomerId: DotyposCustomerId;
  /** Czech when absent. */
  readonly locale?: Locale;
  readonly deliveryAttempt?: number;
  readonly status?: CampaignRecipientStatus;
  readonly providerMessageId?: string;
  readonly failureCode?: string;
};

/** Inserts a send of `campaignId` with its frozen recipients. */
const insertSend = async (
  db: WorkspaceDatabaseClient,
  input: {
    /** A fixed send ID; generated when absent. */
    readonly sendId?: CampaignSendId;
    readonly campaignId: CampaignId;
    readonly automationVersionId?: AutomationVersionId;
    readonly purpose: CampaignPurpose;
    readonly content: CampaignLocalizedContent;
    readonly deliveryAttempt?: number;
    readonly recipients: readonly SeededRecipient[];
  }
): Promise<CampaignSendId> => {
  const [send] = await Effect.runPromise(
    db
      .insert(emailCampaignSends)
      .values({
        id: input.sendId,
        campaignId: input.campaignId,
        automationVersionId: input.automationVersionId,
        audienceFilter: everyoneFilter,
        contentHash: hashCampaignContent({
          purpose: input.purpose,
          templateKey: "workspace",
          locales: input.content,
        }),
        deliveryAttempt: input.deliveryAttempt ?? 1,
      })
      .returning()
  );
  assert(send, "Expected an inserted campaign send");
  if (input.recipients.length > 0) {
    await Effect.runPromise(
      db.insert(emailCampaignRecipients).values(
        input.recipients.map((recipient) => ({
          ...recipient,
          skipReason:
            recipient.status === "skipped" ? ("missing-email" as const) : null,
          sendId: send.id,
          locale: recipient.locale ?? "cs-CZ",
        }))
      )
    );
  }
  return send.id;
};

/**
 * Inserts a campaign in `status` with its frozen send and recipients, as a
 * confirmed send leaves them, and returns their IDs.
 */
export const seedCampaignSend = async (
  db: WorkspaceDatabaseClient,
  input: {
    readonly sendId?: CampaignSendId;
    readonly purpose: CampaignPurpose;
    readonly status?: CampaignStatus;
    readonly deliveryAttempt?: number;
    readonly content?: CampaignLocalizedContent;
    readonly recipients: readonly SeededRecipient[];
  }
) => {
  const content = input.content ?? campaignContentFixture();
  const [campaign] = await Effect.runPromise(
    db
      .insert(emailCampaigns)
      .values({
        title: "Autumn news",
        purpose: input.purpose,
        templateKey: "workspace",
        content,
        status: input.status ?? "sending",
      })
      .returning()
  );
  assert(campaign, "Expected an inserted campaign");
  const sendId = await insertSend(db, {
    ...input,
    campaignId: campaign.id,
    content,
  });
  return { campaignId: campaign.id, sendId };
};

/** Reusable 7-locale pass reminder Email Library document for tests. */
export const passReminderEmailDocumentFixture = (
  trigger: EmailTriggerEvent
): typeof EmailDocument.Encoded => ({
  purpose: "marketing",
  templateKey: "workspace",
  values: [{ name: "pass", source: { kind: "trigger", trigger } }],
  structure: [
    {
      _tag: "Paragraph",
      id: "greeting_named",
      textKey: "greeting_named",
      when: { name: "pass", field: ["firstName"], present: true },
    },
    {
      _tag: "Paragraph",
      id: "greeting_unnamed",
      textKey: "greeting_unnamed",
      when: { name: "pass", field: ["firstName"], present: false },
    },
    {
      _tag: "Paragraph",
      id: "body",
      textKey: "body",
    },
    ...(trigger === "unlimited-ending"
      ? [
          {
            _tag: "Paragraph" as const,
            id: "desk_note",
            textKey: "desk_note",
            when: { name: "pass", field: ["deskLabel"], present: true },
          },
        ]
      : []),
    {
      _tag: "Button",
      id: "cta",
      labelKey: "cta_label",
      hrefValue: { name: "pass", field: ["actionUrl"] },
    },
  ],
  translations: mapSupportedLocales((locale) => ({
    subject:
      trigger === "entry-pack-expiring"
        ? [
            { _tag: "Text" as const, text: `[${locale}] Entries left: ` },
            {
              _tag: "Value" as const,
              name: "pass",
              field: ["remainingEntries"],
            },
            { _tag: "Text" as const, text: " until " },
            { _tag: "Value" as const, name: "pass", field: ["endsOn"] },
          ]
        : [
            { _tag: "Text" as const, text: `[${locale}] Membership ends ` },
            { _tag: "Value" as const, name: "pass", field: ["endsOn"] },
          ],
    preheader: [
      { _tag: "Value" as const, name: "pass", field: ["tier"] },
      { _tag: "Text" as const, text: " · " },
      { _tag: "Value" as const, name: "pass", field: ["endsOn"] },
    ],
    texts: {
      greeting_named: [
        { _tag: "Text" as const, text: "Hi " },
        { _tag: "Value" as const, name: "pass", field: ["firstName"] },
        { _tag: "Text" as const, text: "," },
      ],
      greeting_unnamed: [{ _tag: "Text" as const, text: "Hello," }],
      body:
        trigger === "entry-pack-expiring"
          ? [
              { _tag: "Text" as const, text: "Remaining: " },
              {
                _tag: "Value" as const,
                name: "pass",
                field: ["remainingEntries"],
                bold: true,
              },
              { _tag: "Text" as const, text: "/" },
              { _tag: "Value" as const, name: "pass", field: ["totalEntries"] },
              { _tag: "Text" as const, text: " (" },
              { _tag: "Value" as const, name: "pass", field: ["tier"] },
              { _tag: "Text" as const, text: ")" },
            ]
          : [
              { _tag: "Text" as const, text: "Extend your membership from " },
              {
                _tag: "Value" as const,
                name: "pass",
                field: ["renewalStartsOn"],
                bold: true,
              },
              { _tag: "Text" as const, text: " (" },
              { _tag: "Value" as const, name: "pass", field: ["tier"] },
              { _tag: "Text" as const, text: ")" },
            ],
      ...(trigger === "unlimited-ending" && {
        desk_note: [
          { _tag: "Text" as const, text: "Reserved desk: " },
          {
            _tag: "Value" as const,
            name: "pass",
            field: ["deskLabel"],
            bold: true,
          },
        ],
      }),
      cta_label: [
        {
          _tag: "Text" as const,
          text:
            trigger === "entry-pack-expiring"
              ? "Book a day"
              : "Extend membership",
        },
      ],
    },
  })),
});

/** Publishes a reusable Email Library document and returns its IDs. */
export const seedPublishedEmail = async (
  db: WorkspaceDatabaseClient,
  input: {
    readonly title?: string;
    readonly document: typeof EmailDocument.Encoded;
  }
): Promise<{
  readonly emailId: EmailId;
  readonly versionId: EmailVersionId;
}> => {
  const published = Schema.decodeUnknownSync(EmailDocumentForPublication)(
    input.document
  );
  const [email] = await Effect.runPromise(
    db
      .insert(emails)
      .values({
        title: input.title ?? "Synthetic published email",
        draft: input.document,
      })
      .returning({ id: emails.id })
  );
  assert(email, "Expected an inserted email");
  const [version] = await Effect.runPromise(
    db
      .insert(emailVersions)
      .values({
        emailId: email.id,
        versionNumber: 1,
        document: published,
        requiredValueNames: [...requiredEmailValueNames(published)],
      })
      .returning({ id: emailVersions.id })
  );
  assert(version, "Expected an inserted email version");
  return { emailId: email.id, versionId: version.id };
};

/**
 * Inserts an automated campaign in `status` (Active by default) whose own
 * purpose and content differ from anything its versions publish.
 */
export const seedAutomatedCampaign = async (
  db: WorkspaceDatabaseClient,
  input: {
    readonly purpose: CampaignPurpose;
    readonly status?: (typeof automatedCampaignStatuses)[number];
    readonly emailId?: EmailId;
  }
) => {
  const [campaign] = await Effect.runPromise(
    db
      .insert(emailCampaigns)
      .values({
        title: "Come back soon",
        purpose: input.purpose,
        templateKey: "workspace",
        content: input.emailId
          ? {}
          : campaignContentFixture("Rozpracovaný koncept"),
        emailId: input.emailId ?? null,
        delivery: "automated",
        status: input.status ?? "active",
      })
      .returning({ id: emailCampaigns.id })
  );
  assert(campaign, "Expected an inserted automated campaign");
  return campaign.id;
};

/**
 * Publishes version `versionNumber` of `campaignId` with `purpose` and the
 * content `text`, as activation will. `trigger` and `activatedAt` default to
 * a placeholder trigger and an activation ordered by version number; `flow`
 * replaces the whole stored flow, including its trigger. Pass `flow` where
 * the engine decodes the version's flow: the placeholder flow built from
 * `trigger` doesn't decode.
 */
export const seedAutomationVersion = async (
  db: WorkspaceDatabaseClient,
  input: {
    readonly campaignId: CampaignId;
    readonly purpose: CampaignPurpose;
    readonly versionNumber?: number;
    readonly text?: string;
    /** Replaces the content `text` builds. */
    readonly content?: CampaignLocalizedContent;
    readonly emailId?: EmailId;
    readonly frozenEmailVersionId?: EmailVersionId;
    readonly trigger?: AutomationTrigger;
    readonly audienceFilter?: AudienceFilter;
    readonly activatedAt?: Temporal.Instant;
    readonly flow?: unknown;
  }
) => {
  const content = input.emailId
    ? {}
    : (input.content ?? campaignContentFixture(input.text ?? "Verze"));
  const [version] = await Effect.runPromise(
    db
      .insert(emailCampaignAutomationVersions)
      .values({
        campaignId: input.campaignId,
        versionNumber: input.versionNumber ?? 1,
        flow: input.flow ?? {
          trigger: input.trigger ?? { _tag: "reservation-booked" },
          steps: [],
        },
        purpose: input.purpose,
        templateKey: "workspace",
        content,
        emailId: input.emailId ?? null,
        frozenEmailVersionId: input.frozenEmailVersionId ?? null,
        contentHash: input.frozenEmailVersionId
          ? hashCampaignEmailVersion(input.frozenEmailVersionId)
          : hashCampaignContent({
              purpose: input.purpose,
              templateKey: "workspace",
              locales: content,
            }),
        audienceFilter: input.audienceFilter ?? everyoneFilter,
        draftHash: `draft-${input.versionNumber ?? 1}`,
        activatedAt:
          input.activatedAt ??
          sql`now() + make_interval(secs => ${input.versionNumber ?? 1})`,
      })
      .returning({ id: emailCampaignAutomationVersions.id })
  );
  assert(version, "Expected an inserted automation version");
  return version.id;
};

/**
 * Inserts the automation row of `campaignId` with `activeVersionId` in
 * force, as activation and the lifecycle operations leave it. `flow`, the
 * working copy, defaults to the active version's flow.
 */
export const seedAutomation = async (
  db: WorkspaceDatabaseClient,
  input: {
    readonly campaignId: CampaignId;
    readonly activeVersionId: AutomationVersionId;
    readonly flow?: AutomationFlow;
    readonly acceptingSince?: Temporal.Instant | null;
    readonly pausedAt?: Temporal.Instant | null;
    readonly resumedAt?: Temporal.Instant | null;
    readonly nextFireAt?: Temporal.Instant | null;
  }
) => {
  await Effect.runPromise(
    db.insert(emailCampaignAutomations).values({
      campaignId: input.campaignId,
      flow:
        input.flow ??
        sql`(select ${emailCampaignAutomationVersions.flow} from ${emailCampaignAutomationVersions} where ${emailCampaignAutomationVersions.id} = ${input.activeVersionId})`,
      activeVersionId: input.activeVersionId,
      acceptingSince: input.acceptingSince ?? null,
      pausedAt: input.pausedAt ?? null,
      resumedAt: input.resumedAt ?? null,
      nextFireAt: input.nextFireAt ?? null,
    })
  );
};

/**
 * Inserts one automated send of `versionId` with its recipients, as a
 * deliver unit will.
 */
export const seedAutomatedSend = (
  db: WorkspaceDatabaseClient,
  input: {
    readonly sendId?: CampaignSendId;
    readonly campaignId: CampaignId;
    readonly versionId: AutomationVersionId;
    readonly purpose: CampaignPurpose;
    readonly text?: string;
    readonly recipients: readonly SeededRecipient[];
  }
) =>
  insertSend(db, {
    ...input,
    automationVersionId: input.versionId,
    content: campaignContentFixture(input.text ?? "Verze"),
  });

/**
 * Deletes campaigns with their automation rows, receipts, claims, runs, units,
 * fires, sends, recipients and versions. Versions are immutable, so
 * removing them takes the same exclusive lock and trigger toggle an
 * operator would need.
 */
export const deleteAutomatedCampaigns = (
  db: RootDatabaseClient,
  campaignIds: readonly CampaignId[]
) =>
  Effect.runPromise(
    Effect.flatMap(WorkspaceDatabase, ({ transaction }) =>
      transaction(
        Effect.gen(function* () {
          yield* db
            .delete(emailCampaignAutomationTriggerReceipts)
            .where(
              inArray(
                emailCampaignAutomationTriggerReceipts.campaignId,
                campaignIds
              )
            );
          // Claims reference their runs.
          yield* db
            .delete(emailCampaignAutomationCustomerClaims)
            .where(
              inArray(
                emailCampaignAutomationCustomerClaims.campaignId,
                campaignIds
              )
            );
          yield* db
            .delete(emailCampaignAutomationRuns)
            .where(
              inArray(emailCampaignAutomationRuns.campaignId, campaignIds)
            );
          yield* db
            .delete(emailCampaignAutomationWorkUnits)
            .where(
              inArray(emailCampaignAutomationWorkUnits.campaignId, campaignIds)
            );
          yield* db
            .delete(emailCampaignAutomationScheduleFires)
            .where(
              inArray(
                emailCampaignAutomationScheduleFires.campaignId,
                campaignIds
              )
            );
          // The automation row references its active version.
          yield* db
            .delete(emailCampaignAutomations)
            .where(inArray(emailCampaignAutomations.campaignId, campaignIds));
          yield* db
            .delete(emailCampaignSends)
            .where(inArray(emailCampaignSends.campaignId, campaignIds));
          yield* db.execute(
            sql`lock table ${emailCampaignAutomationVersions} in access exclusive mode`
          );
          yield* db.execute(
            sql`alter table ${emailCampaignAutomationVersions} disable trigger email_campaign_automation_versions_immutable`
          );
          yield* db
            .delete(emailCampaignAutomationVersions)
            .where(
              inArray(emailCampaignAutomationVersions.campaignId, campaignIds)
            );
          yield* db.execute(
            sql`alter table ${emailCampaignAutomationVersions} enable trigger email_campaign_automation_versions_immutable`
          );
          yield* db
            .delete(emailCampaigns)
            .where(inArray(emailCampaigns.id, campaignIds));
        })
      )
    ).pipe(Effect.provideService(WorkspaceDatabase, WorkspaceDatabase.make(db)))
  );

/** Deletes campaigns with their sends and recipients. */
export const deleteCampaigns = async (
  pool: {
    readonly query: (sql: string, params: unknown[]) => Promise<unknown>;
  },
  campaignIds: readonly string[]
) => {
  await pool.query(
    "delete from email_campaign_sends where campaign_id = any($1)",
    [campaignIds]
  );
  await pool.query("delete from email_campaigns where id = any($1)", [
    campaignIds,
  ]);
};
