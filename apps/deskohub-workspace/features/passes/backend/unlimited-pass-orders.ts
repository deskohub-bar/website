import "server-only";

import { createHash } from "node:crypto";
import type { DotyposCustomerId, DotyposTableId } from "@deskohub/dotypos";
import { NexiCorrelationIdSchema } from "@deskohub/nexi";
import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import {
  customerAccounts,
  orders,
  passPurchases,
  workspaceReservations,
} from "@/db/schema";
import type { CustomerAccountId } from "@/features/account/customer-account";
import {
  checkoutAttemptKeySchema,
  checkoutSessionKeySchema,
  type PaymentAttemptId,
} from "@/features/checkout/checkout-identifiers";
import type { Locale } from "@/features/i18n";
import { isEndedUnpaidPaymentState, type OrderId } from "@/features/order";
import { StoredReservationDetails } from "@/features/reservation/backend/stored-reservation-details.server";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { getReservationHoldExpiresAt } from "@/features/reservation/reservation-hold-deadline";
import type { PlainDate } from "@/shared/utils/temporal";
import { unlimitedPassDays } from "../pass-offer";
import {
  type PassPurchaseQuote,
  passPurchaseQuoteCodec,
} from "../pass-purchase-quote";
import {
  getUnlimitedPassEndDate,
  type UnlimitedPassSelection,
} from "../unlimited-pass";

export class UnlimitedPassAdmissionError extends Data.TaggedError(
  "UnlimitedPassAdmissionError"
)<{
  readonly reason:
    | "holder-unavailable"
    | "overlapping-pass"
    | "draft-changed"
    | "purchase-conflict";
}> {}

type PassDayPlan = {
  readonly serviceDate: PlainDate;
  readonly tableId: DotyposTableId;
};

export function readUnlimitedPassSelection(
  purchase: typeof passPurchases.$inferSelect
): UnlimitedPassSelection | undefined {
  const startDate = purchase.validFrom;
  switch (purchase.tier) {
    case "open-space":
      return {
        tier: purchase.tier,
        startDate,
        coffee: purchase.unlimitedCoffee === true,
      };
    case "reserved-desk":
      return { tier: purchase.tier, startDate };
    case "reserved-desk-workstation":
      if (!purchase.unlimitedMonitorOption) return undefined;
      return {
        tier: purchase.tier,
        startDate,
        monitorOption: purchase.unlimitedMonitorOption,
      };
  }
}

export const recordReplacementUnlimitedPassHolds = Effect.fn(
  "recordReplacementUnlimitedPassHolds"
)(function* (input: {
  readonly purchase: typeof passPurchases.$inferSelect;
  readonly paidAttemptId: PaymentAttemptId;
  readonly days: readonly PassDayPlan[];
  readonly now: Temporal.Instant;
}) {
  const { db } = yield* WorkspaceTransaction;
  const { purchase, paidAttemptId, days, now } = input;
  const [order] = yield* db
    .select()
    .from(orders)
    .where(eq(orders.id, purchase.id))
    .for("no key update");
  if (
    !order ||
    order.activePaymentAttemptId !== paidAttemptId ||
    !isEndedUnpaidPaymentState(order.paymentState)
  ) {
    return yield* new UnlimitedPassAdmissionError({
      reason: "purchase-conflict",
    });
  }
  yield* requireUnlimitedPassWindow({
    orderId: purchase.id,
    holderAccountId: purchase.holderAccountId,
    validFrom: purchase.validFrom,
    validUntil: purchase.validUntil,
  });
  const holdsExpireAt = getReservationHoldExpiresAt(now);
  for (const day of days) {
    const [reserved] = yield* db
      .update(workspaceReservations)
      .set({
        passDayTableId: day.tableId,
        passDayHoldRequestedAt: null,
        passDayHoldGeneration: crypto.randomUUID(),
        failureCode: null,
        reservationHoldExpiresAt: holdsExpireAt,
        reservationHoldExpiredAt: null,
        reservationCancelledAt: null,
        dotyposReservationId: null,
        reservationState: "creating_hold",
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceReservations.passId, purchase.id),
          eq(workspaceReservations.serviceDate, day.serviceDate),
          inArray(workspaceReservations.reservationState, [
            "cancelled",
            "hold_expired",
          ])
        )
      )
      .returning({ id: workspaceReservations.id });
    if (!reserved)
      return yield* new UnlimitedPassAdmissionError({
        reason: "purchase-conflict",
      });
  }
  const [updated] = yield* db
    .update(passPurchases)
    .set({ status: "pending_payment", holdsExpireAt })
    .where(
      and(eq(passPurchases.id, purchase.id), eq(passPurchases.status, "void"))
    )
    .returning();
  if (!updated)
    return yield* new UnlimitedPassAdmissionError({
      reason: "purchase-conflict",
    });
  return updated;
});

/** A holder lock serializes pending entitlement claims even for different buyers. */
export const requireUnlimitedPassWindow = Effect.fn(
  "requireUnlimitedPassWindow"
)(function* (input: {
  readonly orderId: OrderId;
  readonly holderAccountId: CustomerAccountId;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
}) {
  const { db } = yield* WorkspaceTransaction;
  const [holder] = yield* db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.id, input.holderAccountId),
        isNull(customerAccounts.deletedAt)
      )
    )
    .for("no key update");
  if (!holder) {
    return yield* new UnlimitedPassAdmissionError({
      reason: "holder-unavailable",
    });
  }
  const [overlap] = yield* db
    .select({ id: passPurchases.id })
    .from(passPurchases)
    .where(
      and(
        ne(passPurchases.id, input.orderId),
        eq(passPurchases.product, "unlimited"),
        eq(passPurchases.holderAccountId, input.holderAccountId),
        lt(passPurchases.validFrom, input.validUntil),
        sql`coalesce(${passPurchases.accessEndsOn}, ${passPurchases.validUntil}) > ${input.validFrom}`,
        sql`(${passPurchases.status} in ('pending_payment', 'active') or
          (${passPurchases.status} in ('withdrawn', 'cancelled') and ${passPurchases.accessEndsOn} > ${passPurchases.validFrom}))`
      )
    )
    .limit(1);
  if (overlap) {
    return yield* new UnlimitedPassAdmissionError({
      reason: "overlapping-pass",
    });
  }
});

export const recordUnlimitedPassOrder = Effect.fn("recordUnlimitedPassOrder")(
  function* (input: {
    readonly orderId: OrderId;
    readonly buyer: {
      readonly accountId: CustomerAccountId;
      readonly customerId: DotyposCustomerId;
    };
    readonly holder: {
      readonly accountId: CustomerAccountId;
      readonly customerId: DotyposCustomerId;
    };
    readonly locale: Locale;
    readonly createdAt: Temporal.Instant;
    readonly selection: UnlimitedPassSelection;
    readonly quote: PassPurchaseQuote;
    readonly days: readonly PassDayPlan[];
  }) {
    const { db } = yield* WorkspaceTransaction;
    const { selection, holder, buyer, orderId, locale, createdAt } = input;
    const validFrom = selection.startDate;
    const validUntil = getUnlimitedPassEndDate(validFrom);
    const start = Temporal.PlainDate.from(validFrom);
    if (
      input.days.length !== unlimitedPassDays ||
      input.days.some(
        ({ serviceDate }, index) =>
          serviceDate !== start.add({ days: index }).toString()
      )
    ) {
      return yield* Effect.die(
        "Unlimited pass capacity plan does not cover its service dates."
      );
    }
    yield* requireUnlimitedPassWindow({
      orderId,
      holderAccountId: holder.accountId,
      validFrom,
      validUntil,
    });

    const [order] = yield* db
      .insert(orders)
      .values({
        id: orderId,
        kind: "pass-purchase",
        dotyposCustomerId: buyer.customerId,
        paymentState: "not_started",
        fulfillmentState: "not_started",
      })
      .onConflictDoNothing({ target: orders.id })
      .returning({ id: orders.id });
    if (!order) {
      return yield* new UnlimitedPassAdmissionError({
        reason: "purchase-conflict",
      });
    }

    const holdsExpireAt = getReservationHoldExpiresAt(createdAt);
    const quote = yield* Schema.encodeEffect(passPurchaseQuoteCodec)(
      input.quote
    );
    const [purchase] = yield* db
      .insert(passPurchases)
      .values({
        id: orderId,
        buyerAccountId: buyer.accountId,
        holderAccountId: holder.accountId,
        product: "unlimited",
        tier: selection.tier,
        unlimitedCoffee:
          selection.tier === "open-space" ? selection.coffee : null,
        unlimitedMonitorOption:
          selection.tier === "reserved-desk-workstation"
            ? selection.monitorOption
            : null,
        status: "pending_payment",
        validFrom,
        validUntil,
        holdsExpireAt,
        quote,
        locale,
        createdAt,
      })
      .returning();
    if (!purchase)
      return yield* Effect.die("Unlimited pass insert returned no row.");

    const reservationDetails = yield* StoredReservationDetails.encode(
      selection.tier === "open-space"
        ? { kind: "cowork", entryTier: "open-space", coffee: selection.coffee }
        : {
            kind: "cowork",
            entryTier: "reserved-desk",
            coffee: true,
            ...(selection.tier === "reserved-desk-workstation" && {
              monitorOption: selection.monitorOption,
            }),
          }
    );
    yield* db.insert(workspaceReservations).values(
      input.days.map(({ serviceDate, tableId }) => {
        const key = createHash("sha256")
          .update(`unlimited-pass-day:${orderId}:${serviceDate}`)
          .digest("hex");
        return {
          id: workspaceReservationIdSchema.make(key),
          passId: orderId,
          serviceDate,
          passDayTableId: tableId,
          checkoutSessionKey: checkoutSessionKeySchema.make(key),
          checkoutAttemptKey: checkoutAttemptKeySchema.make(key),
          correlationId: NexiCorrelationIdSchema.make(key),
          dotyposCustomerId: holder.customerId,
          authorAccountId: buyer.accountId,
          reservationState: "creating_hold",
          paymentState: "not_started",
          fulfillmentState: "not_started",
          reservationHoldExpiresAt: holdsExpireAt,
          reservationDetails,
          locale,
        } as const;
      })
    );
    return purchase;
  }
);
