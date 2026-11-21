import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { Effect } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { type PaymentAttemptRow, paymentAttempts } from "@/db/schema";
import { postgresUuidV7 } from "@/db/uuid-v7";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { OrderId } from "@/features/order";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { Money } from "@/shared/money/money";
import type { PaymentProvider } from "../payment/payment-provider";
import { toPaymentAttempt } from "./payment-attempt.repository";
import {
  type NonTerminalPaymentAttemptState,
  PaymentLifecycleStateError,
} from "./payment-lifecycle-state";

type NewPaymentAttempt = {
  readonly orderId: OrderId;
  readonly workspaceReservationId: WorkspaceReservationId | null;
  readonly amount: Money;
} & (
  | {
      readonly provider: PaymentProvider | "fio";
      readonly providerOrderId: string;
    }
  | { readonly provider: "internal"; readonly paidAt: Temporal.Instant }
);

/** The order handler owns admission, its claims, and the surrounding transaction. */
export const insertPaymentAttempt = Effect.fn("paymentAttempts.insert")(
  function* (input: NewPaymentAttempt) {
    const { db } = yield* WorkspaceTransaction;
    const [attempt] = yield* db
      .insert(paymentAttempts)
      .values({
        id: postgresUuidV7,
        orderId: input.orderId,
        workspaceReservationId: input.workspaceReservationId,
        amountValue: input.amount.value,
        amountExponent: input.amount.exponent,
        currency: input.amount.currency,
        ...(input.provider !== "internal"
          ? {
              provider: input.provider,
              providerOrderId: input.providerOrderId,
              state: "created",
            }
          : {
              provider: "internal",
              state: "paid",
              createdAt: input.paidAt,
              updatedAt: input.paidAt,
            }),
      })
      .returning();
    if (!attempt)
      return yield* Effect.die("Payment attempt insert returned no row.");
    return attempt;
  }
);

type AttemptSettlement = {
  readonly orderId: OrderId;
  readonly id: PaymentAttemptId;
  readonly webhookEventId?: string;
  readonly providerOperationId?: string;
  readonly providerStatus?: string;
};

/** A new settlement replaces earlier attempt facts. A replay fills gaps. */
export const verifiedSettlementEvidence = (
  input: AttemptSettlement,
  attempt: PaymentAttemptRow
) => {
  const settled = attempt.state === "paid" ? attempt : undefined;
  return {
    lastWebhookEventId:
      settled?.lastWebhookEventId ?? input.webhookEventId ?? null,
    lastProviderOperationId:
      settled?.lastProviderOperationId ?? input.providerOperationId ?? null,
    lastProviderStatus:
      settled?.lastProviderStatus ?? input.providerStatus ?? null,
  };
};

export type SharedCardSettlement = {
  readonly attempt: PaymentAttemptRow;
  readonly windowEligible: boolean;
};

export const markPaymentAttemptPaid = Effect.fn("paymentAttempts.markPaid")(
  function* (
    input: AttemptSettlement & { readonly paidAt: Temporal.Instant },
    sharedCard?: SharedCardSettlement
  ) {
    const { db } = yield* WorkspaceTransaction;
    const [attempt] = yield* db
      .update(paymentAttempts)
      .set({
        state: "paid",
        ...(sharedCard
          ? verifiedSettlementEvidence(input, sharedCard.attempt)
          : {
              lastWebhookEventId: input.webhookEventId,
              lastProviderOperationId: input.providerOperationId,
              lastProviderStatus: input.providerStatus,
            }),
        failureCode: null,
        updatedAt: input.paidAt,
      })
      .where(
        and(
          eq(paymentAttempts.orderId, input.orderId),
          eq(paymentAttempts.id, input.id),
          or(
            inArray(paymentAttempts.state, ["created", "pending", "paid"]),
            sharedCard?.windowEligible
              ? and(
                  eq(paymentAttempts.provider, "nexi"),
                  isNotNull(paymentAttempts.securityToken),
                  inArray(paymentAttempts.state, [
                    "failed",
                    "cancelled",
                    "expired",
                  ])
                )
              : undefined
          )
        )
      )
      .returning();
    return attempt;
  }
);

export const markPaymentAttemptTerminal = Effect.fn(
  "paymentAttempts.markTerminal"
)(function* (
  input: AttemptSettlement & {
    readonly state: "failed" | "cancelled" | "expired";
    readonly failureCode: string;
    readonly fromAttemptStates: readonly NonTerminalPaymentAttemptState[];
    readonly requireTransition?: boolean;
    readonly terminalAt: Temporal.Instant;
  }
) {
  const { db } = yield* WorkspaceTransaction;
  const [attempt] = yield* db
    .update(paymentAttempts)
    .set({
      state: input.state,
      failureCode: input.failureCode,
      lastWebhookEventId: input.webhookEventId,
      lastProviderOperationId: input.providerOperationId,
      lastProviderStatus: input.providerStatus,
      updatedAt: input.terminalAt,
    })
    .where(
      and(
        eq(paymentAttempts.orderId, input.orderId),
        eq(paymentAttempts.id, input.id),
        inArray(
          paymentAttempts.state,
          input.requireTransition
            ? input.fromAttemptStates
            : [...input.fromAttemptStates, input.state]
        )
      )
    )
    .returning();
  return attempt;
});

export const attachPaymentProviderSession = Effect.fn(
  "PaymentLifecycleRepository.attachProviderSession"
)(function* (input: {
  readonly id: PaymentAttemptId;
  readonly securityToken: string;
  readonly providerRedirectUrl: string;
}) {
  const { db } = yield* WorkspaceDatabase;
  const providerOrderCreatedAt = Temporal.Now.instant();
  const [attempt] = yield* db
    .update(paymentAttempts)
    .set({
      state: "pending",
      securityToken: input.securityToken,
      providerRedirectUrl: input.providerRedirectUrl,
      providerOrderCreatedAt,
      updatedAt: providerOrderCreatedAt,
    })
    .where(
      and(
        eq(paymentAttempts.id, input.id),
        eq(paymentAttempts.state, "created")
      )
    )
    .returning();

  if (!attempt) {
    return yield* new PaymentLifecycleStateError({
      operation: "PaymentLifecycleRepository.attachProviderSession",
      paymentReference: { type: "paymentAttemptId", id: input.id },
      message: "Only created payment attempts can attach a provider session.",
    });
  }

  return toPaymentAttempt(attempt);
});
