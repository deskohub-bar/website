"use server";

import { EmailDraft, EmailId } from "@deskohub/workspace-admin-api";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { administrationHref } from "@/features/administration/administration-href";
import { m } from "@/features/administration/i18n";
import { defineAdministrationAction } from "@/features/administrators/server/administration-request.server";
import { EmailPersistence } from "@/features/emails/backend";
import { writeEmailDraft } from "@/features/emails/backend/write-email-draft";
import { emailsEditorActionFailureCopy } from "../editor/editor-action-failure-copy";

const capabilities = EmailPersistence.Default.pipe(
  Layer.provideMerge(WorkspaceDatabase.Default)
);
const libraryHref = administrationHref(
  "/[locale]/admin/email-campaigns/library"
);

const createReusableEmailAction = defineAdministrationAction(
  {
    operation: "emails.admin.create",
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({ title: Schema.Trim.check(Schema.isNonEmpty()) })
    ),
    capabilities,
    failureCopy: emailsEditorActionFailureCopy,
    revalidates: () => [libraryHref],
  },
  Effect.fn("createReusableEmail")(function* ({ title }) {
    const emails = yield* EmailPersistence;
    const { id } = yield* emails.create({
      title,
      draft: { purpose: "marketing", templateKey: "workspace" },
    });
    return { emailId: id };
  })
);

const writeReusableEmailAction = defineAdministrationAction(
  {
    operation: "emails.admin.write-draft",
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({
        emailId: EmailId,
        draft: EmailDraft,
        publish: Schema.Boolean,
      })
    ),
    capabilities,
    failureCopy: emailsEditorActionFailureCopy,
    publicFailure: (failure, locale) => {
      if (
        failure._tag === "EmailPublicationInvalid" ||
        failure._tag === "EmailImageNotAllowed"
      )
        return m.emailsLibraryPublicationInvalid({}, { locale });
      if (failure._tag === "EmailNotFound")
        return m.emailsLibraryNotFound({}, { locale });
      return undefined;
    },
    revalidates: ({ emailId, publish }) => [
      libraryHref,
      administrationHref("/[locale]/admin/email-campaigns/library/[emailId]", {
        emailId,
      }),
      ...(publish
        ? [
            administrationHref("/[locale]/admin/email-campaigns/new"),
            administrationHref("/[locale]/admin/email-campaigns"),
          ]
        : []),
    ],
  },
  writeEmailDraft
);

export const createReusableEmail: typeof createReusableEmailAction = async (
  ...args
) => {
  "use server";
  return await createReusableEmailAction(...args);
};

export const writeReusableEmail: typeof writeReusableEmailAction = async (
  ...args
) => {
  "use server";
  return await writeReusableEmailAction(...args);
};
