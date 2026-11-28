import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  customerAccounts,
  passPurchases,
  workspaceReservations,
} from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { getReservationHoldExpiresAt } from "@/features/reservation/reservation-hold-deadline";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";
import {
  currentInstant,
  getPlainDatesBetween,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import { withUnlimitedPassCapacityForDates } from "../backend/unlimited-pass-capacity";
import { readUnlimitedPassDays } from "../backend/unlimited-pass-holds";
import {
  makeUnlimitedPassDayRows,
  readUnlimitedPassDesk,
  readUnlimitedPassSelection,
  requireUnlimitedPassWindow,
} from "../backend/unlimited-pass-orders";
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

type Adjustment = PassChangeRequest & {
  readonly change: Exclude<PassChangeRequest["change"], { _tag: "grant" }>;
};

const ensureActiveUnlimited = Effect.fn("ensureActiveUnlimited")(function* (
  passId: Adjustment["passId"]
) {
  const locked = yield* lockPassForChange(passId);
  const { order, purchase } = locked;
  if (
    purchase.product !== "unlimited" ||
    purchase.status !== "active" ||
    (order.paymentState !== "paid" && order.paymentState !== "complimentary")
  ) {
    return yield* new PassChangeRefused({ reason: "changed" });
  }
  return locked;
});

const requireNoPassSuccessor = Effect.fn("requireNoPassSuccessor")(function* (
  passId: Adjustment["passId"]
) {
  const { db } = yield* WorkspaceTransaction;
  const [successor] = yield* db
    .select({ id: passPurchases.id })
    .from(passPurchases)
    .where(
      and(
        eq(passPurchases.renewsPassId, passId),
        inArray(passPurchases.status, ["active", "pending_payment"])
      )
    )
    .limit(1);
  if (successor)
    return yield* new PassChangeRefused({ reason: "successor-present" });
});

const beginUnlimitedExtension = Effect.fn("beginUnlimitedExtension")(function* (
  input: Adjustment & {
    readonly change: Extract<Adjustment["change"], { _tag: "validity" }>;
  }
) {
  const { db, transaction } = yield* WorkspaceDatabase;
  const actor = yield* CurrentAdministrator;
  const { passId, change } = input;
  const [purchase] = yield* db
    .select()
    .from(passPurchases)
    .where(eq(passPurchases.id, passId));
  if (!purchase) return yield* new PassChangeRefused({ reason: "not-found" });
  const selection = readUnlimitedPassSelection(purchase);
  if (!selection) return yield* new PassChangeRefused({ reason: "changed" });
  const now = yield* currentInstant;
  const today = getWorkspaceDate(now).toString();
  const validUntil = passValidityEnd(change.lastDay);
  if (
    change.expectedValidUntil < today ||
    change.lastDay > getWorkspaceAvailabilityRange(today).to ||
    change.refundValue !== 0
  )
    return yield* new PassChangeRefused({ reason: "invalid-validity" });
  const desk = yield* readUnlimitedPassDesk(passId);
  if (selection.tier !== "open-space" && !desk) {
    return yield* new PassChangeRefused({ reason: "capacity" });
  }
  const dates = getPlainDatesBetween(
    Temporal.PlainDate.from(change.expectedValidUntil),
    Temporal.PlainDate.from(change.lastDay)
  );
  const days = yield* readUnlimitedPassDays(passId);
  const first = days.find((day) => day.serviceDate === purchase.validFrom);
  if (!first) return yield* new PassChangeRefused({ reason: "changed" });

  return yield* withUnlimitedPassCapacityForDates(
    { selection, dates, preferredDeskId: desk },
    (plan) =>
      transaction(
        Effect.gen(function* () {
          const { db } = yield* WorkspaceTransaction;
          const locked = yield* ensureActiveUnlimited(passId);
          if (
            locked.purchase.validUntil !== change.expectedValidUntil ||
            locked.purchase.holderAccountId !== purchase.holderAccountId
          ) {
            return yield* new PassChangeRefused({ reason: "changed" });
          }
          yield* requireNoPendingPassChange(passId);
          if (desk && plan.pinnedDesk?.id !== desk) {
            return yield* new PassChangeRefused({ reason: "capacity" });
          }
          yield* requireUnlimitedPassWindow({
            orderId: passId,
            holderAccountId: purchase.holderAccountId,
            validFrom: purchase.validFrom,
            validUntil,
          });
          yield* requireNoPassSuccessor(passId);
          const rows = yield* makeUnlimitedPassDayRows({
            orderId: passId,
            selection,
            buyerAccountId: purchase.buyerAccountId,
            holderCustomerId: first.dotyposCustomerId,
            days: plan.days.map(({ tableId, serviceDate }) => ({
              tableId,
              serviceDate: plainDateStringSchema.make(serviceDate.toString()),
            })),
            holdsExpireAt: getReservationHoldExpiresAt(now),
            locale: purchase.locale,
          });
          for (const row of rows) {
            const [replaced] = yield* db
              .update(workspaceReservations)
              .set({
                ...row,
                passDayHoldRequestedAt: null,
                passDayHoldGeneration: null,
                dotyposReservationId: null,
                reservationHoldExpiredAt: null,
                reservationCancelledAt: null,
                reservationCreatedAt: null,
                reservationConfirmedAt: null,
                paidAt: null,
                fulfilledAt: null,
                failureCode: null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(workspaceReservations.id, row.id),
                  inArray(workspaceReservations.reservationState, [
                    "cancelled",
                    "hold_expired",
                  ])
                )
              )
              .returning({ id: workspaceReservations.id });
            if (replaced) continue;
            const [inserted] = yield* db
              .insert(workspaceReservations)
              .values(row)
              .onConflictDoNothing()
              .returning({ id: workspaceReservations.id });
            if (!inserted)
              return yield* new PassChangeRefused({ reason: "changed" });
          }
          return yield* insertPassChange(input, actor, now, "pending");
        })
      ).pipe(WorkspaceLockSections.passPurchaseFulfillment(passId))
  );
});

export const beginUnlimitedPassChange = Effect.fn("beginUnlimitedPassChange")(
  function* (input: Adjustment) {
    const { passId, change } = input;
    const { transaction } = yield* WorkspaceDatabase;
    const actor = yield* CurrentAdministrator;
    return yield* Effect.gen(function* () {
      const replay = yield* transaction(
        readPassChangeReplay(input, actor.accountId)
      );
      if (replay) return replay;
      if (
        change._tag === "validity" &&
        passValidityEnd(change.lastDay) > change.expectedValidUntil
      ) {
        return yield* beginUnlimitedExtension({ ...input, change });
      }

      return yield* transaction(
        Effect.gen(function* () {
          const { db } = yield* WorkspaceTransaction;
          if (change._tag === "reassign") {
            // Renewal admission for the former holder uses this same row lock.
            yield* db
              .select({ id: customerAccounts.id })
              .from(customerAccounts)
              .where(
                inArray(customerAccounts.id, [
                  change.expectedHolderAccountId,
                  change.holderAccountId,
                ])
              )
              .orderBy(asc(customerAccounts.id))
              .for("no key update");
          }
          const locked = yield* ensureActiveUnlimited(passId);
          const { purchase } = locked;
          yield* requireNoPendingPassChange(passId);
          const now = yield* currentInstant;
          const today = getWorkspaceDate(now).toString();
          if (change._tag === "reassign") {
            if (today >= purchase.validFrom)
              return yield* new PassChangeRefused({ reason: "first-use" });
            if (
              change.expectedHolderAccountId !== purchase.holderAccountId ||
              change.expectedHolderVersion !== purchase.holderVersion ||
              change.holderAccountId === purchase.holderAccountId ||
              !change.holderCustomerId
            ) {
              return yield* new PassChangeRefused({ reason: "changed" });
            }
            yield* requireUnlimitedPassWindow({
              orderId: passId,
              holderAccountId: change.holderAccountId,
              validFrom: purchase.validFrom,
              validUntil: purchase.validUntil,
            });
            yield* requireNoPassSuccessor(passId);
            return yield* insertPassChange(input, actor, now, "pending");
          }
          if (change.expectedValidUntil !== purchase.validUntil)
            return yield* new PassChangeRefused({ reason: "changed" });
          if (change._tag === "validity") {
            const validUntil = passValidityEnd(change.lastDay);
            if (
              change.lastDay < today ||
              change.lastDay < purchase.validFrom ||
              validUntil >= purchase.validUntil
            ) {
              return yield* new PassChangeRefused({
                reason: "invalid-validity",
              });
            }
            // The existing renewal access chain uses the predecessor's exclusive end.
            yield* requireUnlimitedPassWindow({
              orderId: passId,
              holderAccountId: purchase.holderAccountId,
              validFrom: purchase.validFrom,
              validUntil,
            });
            yield* requireNoPassSuccessor(passId);
            yield* markPassRefund(locked, change.refundValue, now);
            yield* db
              .update(passPurchases)
              .set({ validUntil })
              .where(eq(passPurchases.id, passId));
            return yield* insertPassChange(input, actor, now, "pending");
          }
          const tomorrow = passValidityEnd(plainDateStringSchema.make(today));
          const earliestCutoff =
            tomorrow < purchase.validFrom ? purchase.validFrom : tomorrow;
          const accessEndsOn =
            earliestCutoff > purchase.validUntil
              ? purchase.validUntil
              : earliestCutoff;
          yield* markPassRefund(locked, change.refundValue, now);
          yield* db
            .update(passPurchases)
            .set({ status: "cancelled", accessEndsOn })
            .where(eq(passPurchases.id, passId));
          return yield* insertPassChange(
            input,
            actor,
            now,
            accessEndsOn < purchase.validUntil ? "pending" : "completed"
          );
        })
      ).pipe(WorkspaceLockSections.passPurchaseFulfillment(passId));
    }).pipe(WorkspaceLockSections.unlimitedPassRecovery(passId));
  }
);
