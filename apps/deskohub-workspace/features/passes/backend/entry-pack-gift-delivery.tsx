import "server-only";

import { createHash } from "node:crypto";
import {
  EmailConfigTag,
  type EmailMessage,
  EmailServiceTag,
} from "@deskohub/email";
import { and, eq } from "drizzle-orm";
import { Effect, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { entryPackGiftInvitations } from "@/db/schema";
import {
  EntryPackGiftInvitationEmail,
  entryPackGiftInvitationSubject,
} from "@/emails/entry-pack-gift-invitation";
import { findEntryPackPurchasePartyContacts } from "@/features/account/backend/customer-account-by-email";
import { getAccountSignInPath } from "@/features/account/routes";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { OrderId } from "@/features/order";
import {
  entryPackGiftSignInHash,
  entryPackGiftSignInModeParam,
} from "@/features/passes/entry-pack-gift-sign-in";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { currentInstant } from "@/shared/utils/temporal";
import {
  makeEntryPackInvitationContext,
  readPendingEntryPackInvitation,
} from "./entry-pack-gift";

// Resend deduplicates for 24 hours. A stale generation stops before that
// window can end, even if cron has been delayed.
const retryWindow = { hours: 23 };
const retryMinutes = [10, 30, 120, 120] as const;

/** Uses the same order section as paid fulfillment and manual resend. */
export const deliverPendingEntryPackInvitation = Effect.fn(
  "deliverPendingEntryPackInvitation"
)(function* (orderId: OrderId, paymentAttemptId: PaymentAttemptId) {
  const now = yield* currentInstant;
  const work = yield* readPendingEntryPackInvitation(orderId, now);
  if (!work) return;

  const { invitation, purchase, deliverable } = work;
  const { db } = yield* WorkspaceDatabase;
  const { generation, attempts } = invitation;
  const currentGeneration = and(
    eq(entryPackGiftInvitations.orderId, orderId),
    eq(entryPackGiftInvitations.generation, generation)
  );
  const stop = db
    .update(entryPackGiftInvitations)
    .set({ nextAttemptAt: null })
    .where(currentGeneration);
  const retryIn = retryMinutes[attempts];
  if (
    !deliverable ||
    retryIn === undefined ||
    (invitation.firstAttemptAt !== null &&
      Temporal.Instant.compare(
        now,
        invitation.firstAttemptAt.add(retryWindow)
      ) >= 0)
  ) {
    yield* stop;
    return;
  }

  const contacts = yield* findEntryPackPurchasePartyContacts([
    purchase.holderAccountId,
    purchase.buyerAccountId,
  ]);
  const holder = contacts.get(purchase.holderAccountId);
  if (!holder) {
    yield* stop;
    return;
  }

  const { ring } = yield* SealedStateKeys;
  const key = invitation.keyId
    ? ring.find(({ kid }) => kid === invitation.keyId)
    : ring[0];
  if (!key) {
    yield* stop;
    return;
  }
  const locale =
    attempts === 0 ? (holder.locale ?? invitation.locale) : invitation.locale;
  yield* db
    .update(entryPackGiftInvitations)
    .set({
      attempts: attempts + 1,
      keyId: key.kid,
      locale,
      nextAttemptAt: now.add({ minutes: retryIn }),
    })
    .where(currentGeneration);

  const sent = yield* Effect.gen(function* () {
    const snapshots = yield* AccountingDocumentSnapshots;
    const snapshot = yield* snapshots.findPassPurchase(paymentAttemptId);
    // Only the buyer's supplied personal name belongs in the invitation.
    // The frozen accounting identity keeps the body stable across attempts.
    const personalName =
      contacts.has(purchase.buyerAccountId) && snapshot?.buyer.kind === "person"
        ? snapshot.buyer.legalName.trim()
        : null;
    const buyerName =
      personalName && !personalName.includes("@") ? personalName : null;
    const context = yield* makeEntryPackInvitationContext(invitation, key);
    const origin =
      invitation.callbackOrigin ??
      (yield* getWorkspaceRuntimeCallbackOrigin).origin;
    const claimUrl = new URL(getAccountSignInPath(locale), origin);
    claimUrl.searchParams.set(entryPackGiftSignInModeParam, "1");
    claimUrl.hash = entryPackGiftSignInHash(context);
    const rendered = yield* renderWorkspaceEmail(
      <EntryPackGiftInvitationEmail
        buyerName={buyerName}
        claimUrl={claimUrl.href}
        entryCount={purchase.entryCount}
        holderEmail={holder.email}
        locale={locale}
        tier={purchase.tier}
        validUntil={purchase.validUntil}
      />
    );
    const { defaultFrom } = yield* EmailConfigTag;
    const message: EmailMessage = {
      ...rendered,
      from: defaultFrom,
      to: { email: holder.email },
      subject: entryPackGiftInvitationSubject({
        buyerName,
        locale,
        entryCount: purchase.entryCount,
      }),
      idempotencyKey: `entry-pack-gift-invitation:${orderId}:${generation}`,
      tags: ["entry_pack_gift_invitation"],
      sensitiveContent: true,
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(message))
      .digest("base64url");
    if (
      invitation.deliveryFingerprint &&
      invitation.deliveryFingerprint !== fingerprint
    ) {
      // The provider may already have sent the original message. Reusing its
      // key with a different payload would leave that send unresolved.
      yield* stop;
      return false;
    }
    if (!invitation.deliveryFingerprint) {
      yield* db
        .update(entryPackGiftInvitations)
        .set({
          callbackOrigin: origin,
          deliveryFingerprint: fingerprint,
          firstAttemptAt: yield* currentInstant,
        })
        .where(currentGeneration);
    }

    const mailer = yield* EmailServiceTag;
    yield* mailer.send(message);
    return true;
  }).pipe(Effect.result);
  if (Result.isFailure(sent)) {
    yield* Effect.logWarning("Entry pack gift invitation send failed");
    return;
  }
  if (!sent.success) return;
  yield* db
    .update(entryPackGiftInvitations)
    .set({ nextAttemptAt: null, sentAt: yield* currentInstant })
    .where(currentGeneration);
});
