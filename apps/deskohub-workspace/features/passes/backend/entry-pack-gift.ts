import "server-only";

import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { Effect, Schema } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  customerAccounts,
  entryPackGiftInvitations,
  orders,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import {
  findPurchaseLoginEmail,
  hasVerifiedActiveLogin,
} from "@/features/account/backend/customer-account-by-email";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import {
  deriveSealedStateSubkey,
  type SealedStateKey,
  SealedStateKeys,
} from "@/shared/backend/sealed-state-keys.service";
import { makeSignedClaims } from "@/shared/backend/signed-claims";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  currentInstant,
  plainDateStringSchema,
  temporalInstantToPlainDate,
} from "@/shared/utils/temporal";
import { hasClaimablePassOrder } from "./entry-pack-payment-eligibility";

type Purchase = typeof passPurchases.$inferSelect;
type Invitation = typeof entryPackGiftInvitations.$inferSelect;

const maxResends = 3;
const resendCooldown = { minutes: 15 };
const invitationLifetime = { hours: 7 * 24 };

const giftClaims = makeSignedClaims({
  purpose: "entry-pack-gift-invitation",
  schema: Schema.Struct({ contextId: Schema.String.check(Schema.isUUID()) }),
});

const invitationSigningKey = (key: SealedStateKey) =>
  deriveSealedStateSubkey(key, "workspace-entry-pack-gift-invitation");

export const makeEntryPackInvitationContext = (
  invitation: Invitation,
  key: SealedStateKey
) =>
  giftClaims.sign({ contextId: invitation.contextId }, [
    invitationSigningKey(key),
  ]);

const readPaidGiftRows = Effect.fnUntraced(function* (
  orderIds: readonly OrderId[]
) {
  const { db } = yield* WorkspaceDatabase;
  return yield* db
    .select({
      purchase: passPurchases,
      invitation: entryPackGiftInvitations,
      holderDeletedAt: customerAccounts.deletedAt,
      refundState: paymentAttempts.refundState,
      paymentAttemptState: paymentAttempts.state,
      paymentState: orders.paymentState,
      refundTarget: paymentAttempts.refundTargetValue,
      refundedAmount: paymentAttempts.refundedAmountValue,
      paidAmount: paymentAttempts.amountValue,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .innerJoin(
      customerAccounts,
      eq(customerAccounts.id, passPurchases.holderAccountId)
    )
    .leftJoin(
      entryPackGiftInvitations,
      and(
        eq(entryPackGiftInvitations.orderId, passPurchases.id),
        eq(
          entryPackGiftInvitations.holderAccountId,
          passPurchases.holderAccountId
        )
      )
    )
    .leftJoin(
      paymentAttempts,
      and(
        eq(paymentAttempts.id, orders.activePaymentAttemptId),
        eq(paymentAttempts.orderId, orders.id)
      )
    )
    .where(
      and(
        inArray(passPurchases.id, orderIds),
        ne(passPurchases.buyerAccountId, passPurchases.holderAccountId),
        eq(orders.kind, "pass-purchase"),
        or(
          and(eq(orders.paymentState, "paid"), isNotNull(orders.paidAt)),
          and(
            eq(orders.paymentState, "complimentary"),
            eq(orders.fulfillmentState, "fulfilled")
          )
        )
      )
    );
});

type PaidGift = Effect.Success<ReturnType<typeof readPaidGiftRows>>[number];

const canInvite = (row: PaidGift, now: Temporal.Instant) =>
  row.holderDeletedAt === null &&
  row.purchase.giftClaimedAt === null &&
  row.purchase.status === "active" &&
  (row.paymentState === "complimentary" ||
    (row.purchase.giftIssuedAt === null && row.refundState === null) ||
    (row.paymentAttemptState === "paid" &&
      (row.refundState === "not_required" ||
        (row.refundTarget !== null &&
          row.paidAmount !== null &&
          Math.max(row.refundTarget, row.refundedAmount ?? 0) <
            row.paidAmount)))) &&
  Temporal.PlainDate.compare(
    now
      .toZonedDateTimeISO(workspaceSiteConstants.location.timeZone)
      .toPlainDate(),
    row.purchase.validUntil
  ) < 0;

const canResend = (row: PaidGift, now: Temporal.Instant) =>
  canInvite(row, now) &&
  (row.invitation === null ||
    (row.invitation.nextAttemptAt === null &&
      row.invitation.generation - row.invitation.firstGeneration < maxResends &&
      Temporal.Instant.compare(
        now,
        (
          row.invitation.sentAt ??
          row.invitation.firstAttemptAt ??
          row.invitation.requestedAt
        ).add(resendCooldown)
      ) >= 0));

export type EntryPackGiftState = {
  readonly invitation: "not_sent" | "pending" | "sent" | "failed";
  readonly claimed: boolean;
  readonly canResend: boolean;
};

/** The caller authorizes these order IDs before reading the buyer's state. */
export const readEntryPackGiftStates = Effect.fn("readEntryPackGiftStates")(
  function* (orderIds: readonly OrderId[]) {
    if (orderIds.length === 0) return new Map<OrderId, EntryPackGiftState>();
    const rows = yield* readPaidGiftRows(orderIds);
    const now = yield* currentInstant;
    return new Map<OrderId, EntryPackGiftState>(
      rows.map((row) => {
        const { invitation, purchase } = row;
        let state: EntryPackGiftState["invitation"] = "not_sent";
        if (invitation?.sentAt) state = "sent";
        else if (invitation?.nextAttemptAt && canInvite(row, now))
          state = "pending";
        else if (invitation?.attempts && !invitation.nextAttemptAt)
          state = "failed";
        return [
          purchase.id,
          {
            invitation: state,
            claimed: purchase.giftClaimedAt !== null,
            canResend: canResend(row, now),
          },
        ];
      })
    );
  }
);

export const readEntryPackGiftState = (orderId: OrderId) =>
  readEntryPackGiftStates([orderId]).pipe(
    Effect.map(
      (states): EntryPackGiftState =>
        states.get(orderId) ?? {
          invitation: "not_sent",
          claimed: false,
          canResend: false,
        }
    )
  );

/** Queue the first invitation in the transaction that issues the gift. */
export const queueInitialEntryPackGift = Effect.fnUntraced(function* (
  purchase: Purchase,
  requestedAt: Temporal.Instant
) {
  if (purchase.buyerAccountId === purchase.holderAccountId) return;

  const { db } = yield* WorkspaceTransaction;
  yield* db
    .insert(entryPackGiftInvitations)
    .values({
      orderId: purchase.id,
      holderAccountId: purchase.holderAccountId,
      generation: 0,
      attempts: 0,
      locale: purchase.locale,
      requestedAt,
      nextAttemptAt: requestedAt,
    })
    .onConflictDoNothing({ target: entryPackGiftInvitations.orderId });
});

/** Call under the order's fulfillment section to serialize against its sender. */
export const queueEntryPackGiftResend = Effect.fnUntraced(function* (
  orderId: OrderId,
  buyerAccountId: CustomerAccountId
) {
  const [row] = yield* readPaidGiftRows([orderId]);
  const now = yield* currentInstant;
  if (
    !row ||
    row.purchase.buyerAccountId !== buyerAccountId ||
    !canResend(row, now)
  ) {
    return false;
  }

  const { purchase, invitation } = row;
  const email = yield* findPurchaseLoginEmail(purchase.holderAccountId);
  if (!email) return false;

  const { db } = yield* WorkspaceDatabase;
  const contextId = crypto.randomUUID();
  yield* db
    .insert(entryPackGiftInvitations)
    .values({
      orderId,
      holderAccountId: purchase.holderAccountId,
      generation: invitation === null ? 0 : invitation.generation + 1,
      contextId,
      attempts: 0,
      locale: purchase.locale,
      requestedAt: now,
      nextAttemptAt: now,
      confirmationInvited: false,
    })
    .onConflictDoUpdate({
      target: entryPackGiftInvitations.orderId,
      set: {
        holderAccountId: purchase.holderAccountId,
        generation: invitation === null ? 0 : invitation.generation + 1,
        contextId,
        attempts: 0,
        locale: purchase.locale,
        requestedAt: now,
        firstAttemptAt: null,
        nextAttemptAt: now,
        sentAt: null,
        keyId: null,
        callbackOrigin: null,
        deliveryFingerprint: null,
      },
    });
  return true;
});

/** The auth boundary calls this only for a newly created verified session. */
export const claimEntryPackGifts = Effect.fn("claimEntryPackGifts")(function* (
  accountId: CustomerAccountId,
  signedInAt: Temporal.Instant
) {
  const { db } = yield* WorkspaceDatabase;
  const signedInOn = plainDateStringSchema.make(
    temporalInstantToPlainDate({
      instant: signedInAt,
      timeZone: workspaceSiteConstants.location.timeZone,
    }).toString()
  );
  yield* db
    .update(passPurchases)
    .set({ giftClaimedAt: signedInAt })
    .where(
      and(
        eq(passPurchases.holderAccountId, accountId),
        ne(passPurchases.buyerAccountId, accountId),
        isNull(passPurchases.giftClaimedAt),
        eq(passPurchases.status, "active"),
        or(isNull(passPurchases.giftIssuedAt), hasClaimablePassOrder(db)),
        gt(passPurchases.validUntil, signedInOn),
        hasVerifiedActiveLogin(db, accountId),
        inArray(
          passPurchases.id,
          db
            .select({ id: orders.id })
            .from(orders)
            .where(
              and(
                eq(orders.kind, "pass-purchase"),
                inArray(orders.paymentState, ["paid", "complimentary"]),
                or(
                  lt(passPurchases.giftIssuedAt, signedInAt),
                  and(
                    isNull(passPurchases.giftIssuedAt),
                    lt(orders.paidAt, signedInAt)
                  )
                )
              )
            )
        )
      )
    );
});

/** Retries a claim write that the verified sign-in could not complete. */
export const recoverEntryPackGiftClaims = (
  accountId: CustomerAccountId,
  verifiedSignInAt: Temporal.Instant | undefined
) =>
  verifiedSignInAt === undefined
    ? Effect.void
    : claimEntryPackGifts(accountId, verifiedSignInAt).pipe(
        Effect.catch(() =>
          Effect.logWarning("Entry pack gift claim recovery failed")
        )
      );

/** The link only prefills sign-in and never substitutes for authentication. */
export const resolveEntryPackGiftInvitation = Effect.fnUntraced(function* (
  contextSecret: string
) {
  if (contextSecret.length > 444) return undefined;

  const claims = yield* giftClaims
    .open(
      contextSecret,
      Effect.map(SealedStateKeys, ({ ring }) => {
        const [first, ...others] = ring;
        return [
          invitationSigningKey(first),
          ...others.map(invitationSigningKey),
        ] as const;
      })
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (!claims) return undefined;

  const { db } = yield* WorkspaceDatabase;
  const [target] = yield* db
    .select({ orderId: entryPackGiftInvitations.orderId })
    .from(entryPackGiftInvitations)
    .where(eq(entryPackGiftInvitations.contextId, claims.contextId));
  if (!target) return undefined;

  const [row] = yield* readPaidGiftRows([target.orderId]);
  const now = yield* currentInstant;
  const invitation = row?.invitation;
  if (
    !row ||
    !invitation?.keyId ||
    !invitation.firstAttemptAt ||
    claims.contextId !== invitation.contextId ||
    !canInvite(row, now) ||
    Temporal.Instant.compare(
      now,
      invitation.firstAttemptAt.add(invitationLifetime)
    ) >= 0
  ) {
    return undefined;
  }

  const email = yield* findPurchaseLoginEmail(row.purchase.holderAccountId);
  return email
    ? {
        orderId: target.orderId,
        email,
        holderAccountId: row.purchase.holderAccountId,
      }
    : undefined;
});

export const readPendingEntryPackInvitation = Effect.fnUntraced(function* (
  orderId: OrderId,
  now: Temporal.Instant
) {
  const [row] = yield* readPaidGiftRows([orderId]);
  const invitation = row?.invitation;
  if (
    !row ||
    !invitation?.nextAttemptAt ||
    Temporal.Instant.compare(now, invitation.nextAttemptAt) < 0
  ) {
    return undefined;
  }
  return {
    invitation,
    purchase: row.purchase,
    deliverable: canInvite(row, now),
  };
});

export const entryPackGiftInvitationDue = (now: Temporal.Instant) =>
  and(
    eq(entryPackGiftInvitations.orderId, orders.id),
    lte(entryPackGiftInvitations.nextAttemptAt, now)
  );

/** Pin the buyer confirmation body before its first attempt. */
export const recordConfirmationInvitationState = Effect.fnUntraced(function* (
  orderId: OrderId
) {
  const { db } = yield* WorkspaceDatabase;
  const [existing] = yield* db
    .select({
      sentAt: entryPackGiftInvitations.sentAt,
      confirmationInvited: entryPackGiftInvitations.confirmationInvited,
    })
    .from(entryPackGiftInvitations)
    .where(eq(entryPackGiftInvitations.orderId, orderId));
  if (!existing) return false;
  if (existing.confirmationInvited !== null)
    return existing.confirmationInvited;

  const accepted = existing.sentAt !== null;
  yield* db
    .update(entryPackGiftInvitations)
    .set({ confirmationInvited: accepted })
    .where(eq(entryPackGiftInvitations.orderId, orderId));
  return accepted;
});
