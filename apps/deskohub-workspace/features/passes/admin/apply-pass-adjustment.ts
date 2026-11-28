import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  entryPackGiftInvitations,
  passEntryClaims,
  passPurchases,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { findPurchaseLoginEmail } from "@/features/account/backend/customer-account-by-email";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { currentInstant } from "@/shared/utils/temporal";
import { passValidityEnd } from "./pass-adjustments";
import type { PassChangeRequest } from "./pass-change";
import {
  insertPassChange,
  lockPassForChange,
  markPassRefund,
  PassChangeRefused,
  readPassChangeReplay,
  requireNoPendingPassChange,
} from "./pass-change-records";

const readPackClaims = Effect.fn("readPackClaims")(function* (
  passId: PassChangeRequest["passId"]
) {
  const { db } = yield* WorkspaceTransaction;
  return yield* db
    .select({ date: passEntryClaims.date, status: passEntryClaims.status })
    .from(passEntryClaims)
    .where(
      and(
        eq(passEntryClaims.passId, passId),
        ne(passEntryClaims.status, "released")
      )
    );
});

const reassignPack = Effect.fn("reassignPack")(function* (
  purchase: Effect.Success<ReturnType<typeof lockPassForChange>>["purchase"],
  change: Extract<PassChangeRequest["change"], { _tag: "reassign" }>,
  now: Temporal.Instant
) {
  if (
    purchase.holderAccountId !== change.expectedHolderAccountId ||
    purchase.holderVersion !== change.expectedHolderVersion ||
    purchase.holderAccountId === change.holderAccountId
  ) {
    return yield* new PassChangeRefused({ reason: "changed" });
  }
  const claims = yield* readPackClaims(purchase.id);
  if (claims.length > 0)
    return yield* new PassChangeRefused({ reason: "first-use" });
  if (!(yield* findPurchaseLoginEmail(change.holderAccountId))) {
    return yield* new PassChangeRefused({ reason: "holder-unavailable" });
  }
  yield* savePassHolder(purchase, change.holderAccountId, now);
});

export const savePassHolder = Effect.fn("savePassHolder")(function* (
  purchase: Effect.Success<ReturnType<typeof lockPassForChange>>["purchase"],
  holderAccountId: CustomerAccountId,
  now: Temporal.Instant
) {
  const { db } = yield* WorkspaceTransaction;
  const toBuyer = purchase.buyerAccountId === holderAccountId;
  const [previous] = yield* db
    .delete(entryPackGiftInvitations)
    .where(eq(entryPackGiftInvitations.orderId, purchase.id))
    .returning({
      generation: entryPackGiftInvitations.generation,
      sentAt: entryPackGiftInvitations.sentAt,
      confirmationInvited: entryPackGiftInvitations.confirmationInvited,
    });
  yield* db
    .update(passPurchases)
    .set({
      holderAccountId,
      holderVersion: sql`${passPurchases.holderVersion} + 1`,
      giftIssuedAt: toBuyer ? null : now,
      giftClaimedAt: null,
    })
    .where(eq(passPurchases.id, purchase.id));
  if (toBuyer && !previous) return;

  const generation = (previous?.generation ?? 0) + 1;
  yield* db.insert(entryPackGiftInvitations).values({
    orderId: purchase.id,
    holderAccountId,
    generation,
    firstGeneration: generation,
    attempts: 0,
    locale: purchase.locale,
    requestedAt: now,
    nextAttemptAt: toBuyer ? null : now,
    confirmationInvited:
      previous?.confirmationInvited ?? Boolean(previous?.sentAt),
  });
});

export const applyPackAdjustment = Effect.fn("applyPackAdjustment")(function* (
  input: PassChangeRequest & {
    readonly change: Exclude<PassChangeRequest["change"], { _tag: "grant" }>;
  }
) {
  const { transaction } = yield* WorkspaceDatabase;
  const actor = yield* CurrentAdministrator;
  return yield* transaction(
    Effect.gen(function* () {
      const { db } = yield* WorkspaceTransaction;
      const locked = yield* lockPassForChange(input.passId);
      const replay = yield* readPassChangeReplay(input, actor.accountId);
      if (replay) return replay;
      yield* requireNoPendingPassChange(input.passId);
      const { purchase } = locked;
      if (
        purchase.product !== "entry-pack" ||
        (purchase.status !== "active" && purchase.status !== "depleted")
      ) {
        return yield* new PassChangeRefused({ reason: "changed" });
      }
      const now = yield* currentInstant;
      const today = getWorkspaceDate(now).toString();
      const { change } = input;
      if (change._tag === "reassign") {
        if (purchase.status !== "active" || today >= purchase.validUntil) {
          return yield* new PassChangeRefused({ reason: "changed" });
        }
        yield* reassignPack(purchase, change, now);
        return yield* insertPassChange(input, actor, now, "completed");
      }
      if (purchase.validUntil !== change.expectedValidUntil) {
        return yield* new PassChangeRefused({ reason: "changed" });
      }

      const claims = yield* readPackClaims(input.passId);
      if (change._tag === "validity") {
        const validUntil = passValidityEnd(change.lastDay);
        if (
          change.lastDay < today ||
          change.lastDay < purchase.validFrom ||
          validUntil === purchase.validUntil ||
          claims.some(({ date }) => date >= validUntil) ||
          (validUntil > purchase.validUntil && change.refundValue !== 0)
        ) {
          return yield* new PassChangeRefused({ reason: "invalid-validity" });
        }
        yield* markPassRefund(locked, change.refundValue, now);
        yield* db
          .update(passPurchases)
          .set({ validUntil })
          .where(eq(passPurchases.id, input.passId));
        return yield* insertPassChange(input, actor, now, "completed");
      }

      if (claims.some(({ status }) => status === "reserved")) {
        return yield* new PassChangeRefused({ reason: "pending-claims" });
      }
      yield* markPassRefund(locked, change.refundValue, now);
      yield* db
        .update(passPurchases)
        .set({ status: "cancelled" })
        .where(eq(passPurchases.id, input.passId));
      return yield* insertPassChange(
        input,
        actor,
        now,
        claims.some(({ date }) => date > today) ? "pending" : "completed"
      );
    })
  ).pipe(WorkspaceLockSections.passPurchaseFulfillment(input.passId));
});
