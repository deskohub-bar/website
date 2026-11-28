import "server-only";

import { EmailDraft, EmailId } from "@deskohub/workspace-admin-api";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { discounts } from "@/db/schema";
import { emails, emailVersions } from "@/db/schema/emails";
import {
  AdministrationRecordNotFound,
  runAdministrationPage,
} from "@/features/administrators/server/administration-request.server";
import { campaignImageCloudName } from "@/features/email-campaigns/body/campaign-image-account";
import { EmailPersistence } from "@/features/emails/backend";
import { emailImages } from "@/features/emails/body/email-image-policy";
import { getRequestLocale } from "@/features/i18n/server/request-locale";

export const loadEmailLibrary = () =>
  runAdministrationPage(
    "emails.admin.list",
    Effect.flatMap(WorkspaceDatabase, ({ db }) =>
      db
        .select({
          emailId: emails.id,
          title: emails.title,
          publishedVersion: sql<
            number | null
          >`max(${emailVersions.versionNumber})`,
        })
        .from(emails)
        .leftJoin(emailVersions, eq(emailVersions.emailId, emails.id))
        .where(isNull(emails.archivedAt))
        .groupBy(emails.id)
        .orderBy(asc(emails.title), asc(emails.id))
    ),
    WorkspaceDatabase.Default
  );

export const loadReusableEmail = (rawId: string) =>
  runAdministrationPage(
    "emails.admin.get",
    Effect.gen(function* () {
      const emailId = Option.getOrUndefined(
        Schema.decodeUnknownOption(EmailId)(rawId)
      );
      if (!emailId) return yield* new AdministrationRecordNotFound();
      const { db } = yield* WorkspaceDatabase;
      const persistence = yield* EmailPersistence;
      const [email] = yield* db
        .select()
        .from(emails)
        .where(eq(emails.id, emailId));
      if (!email || email.archivedAt)
        return yield* new AdministrationRecordNotFound();
      const locale = yield* Effect.promise(() => getRequestLocale());
      const [published, imageCloudName, availableDiscounts] = yield* Effect.all(
        [
          persistence.latestVersion(emailId),
          campaignImageCloudName,
          db
            .select({ id: discounts.id, labels: discounts.labels })
            .from(discounts),
        ],
        { concurrency: "unbounded" }
      );
      const labelsLocale = locale === "cs-CZ" ? "cs-CZ" : "en-US";
      return {
        emailId,
        title: email.title,
        draft: yield* Schema.encodeEffect(EmailDraft)(email.draft),
        publishedVersion: published?.versionNumber ?? null,
        publishedImageSources: published
          ? emailImages(published.document).map(({ source }) => source)
          : [],
        discounts: availableDiscounts
          .map(({ id, labels }) => ({ id, label: labels[labelsLocale] }))
          .sort((first, second) =>
            first.label.localeCompare(second.label, locale)
          ),
        imageCloudName: Option.getOrUndefined(imageCloudName),
      };
    }),
    EmailPersistence.Default.pipe(Layer.provideMerge(WorkspaceDatabase.Default))
  );
