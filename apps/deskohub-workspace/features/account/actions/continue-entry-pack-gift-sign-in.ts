"use server";

import { Effect, Layer, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { getAccountSectionPath } from "@/features/account/routes";
import { resolveEntryPackGiftInvitation } from "@/features/passes/backend/entry-pack-gift";
import { entryPackGiftSignInSecretPattern } from "@/features/passes/entry-pack-gift-sign-in";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";

const continueGiftSignIn = defineWorkspaceAction(
  {
    operation: "account.sign-in.entry-pack-gift",
    logInput: false,
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({
        secret: Schema.String.check(
          Schema.isPattern(entryPackGiftSignInSecretPattern)
        ),
      })
    ),
  },
  Effect.fnUntraced(
    function* ({ secret }, { locale }) {
      const invitation = yield* resolveEntryPackGiftInvitation(secret);
      if (!invitation) return undefined;

      const authentication = yield* CustomerAuthentication;
      const account = yield* authentication.currentUser;
      if (
        account &&
        (account.deletionRequested ||
          account.accountId !== invitation.holderAccountId)
      ) {
        return undefined;
      }

      const query = new URLSearchParams({ pass: invitation.orderId });
      return {
        email: invitation.email,
        returnTo: `${getAccountSectionPath(locale, "passes")}?${query}`,
        alreadySignedIn: account !== null,
      };
    },
    (effect) =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            CustomerAuthentication.Default,
            WorkspaceDatabase.Default,
            SealedStateKeys.Default
          )
        )
      )
  )
);

export async function continueEntryPackGiftSignIn(input: {
  readonly secret: string;
}) {
  return continueGiftSignIn(input);
}
