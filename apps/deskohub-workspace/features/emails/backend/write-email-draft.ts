import "server-only";

import type { EmailDraft, EmailId } from "@deskohub/workspace-admin-api";
import { Effect } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { EmailPersistence } from "./email-persistence.service";

/** A publish saves and publishes the exact submitted draft in one transaction. */
export const writeEmailDraft = Effect.fn("writeEmailDraft")(function* (input: {
  readonly emailId: EmailId;
  readonly draft: EmailDraft;
  readonly publish: boolean;
}) {
  const { transaction } = yield* WorkspaceDatabase;
  const emails = yield* EmailPersistence;
  if (!input.publish) {
    yield* emails.saveDraft(input);
    return { publishedVersion: null };
  }
  return yield* transaction(
    emails.saveDraft(input).pipe(
      Effect.andThen(emails.publish(input.emailId)),
      Effect.map(({ versionNumber }) => ({ publishedVersion: versionNumber }))
    )
  );
});
