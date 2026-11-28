import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isMatchingSecret } from "@deskohub/secret-comparison";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceDatabaseClient,
} from "@/db/database.service";
import { mockPaymentSessions } from "@/db/schema/mock-payment-sessions";
import { isSyntheticE2EEmailRecipient } from "@/features/account/backend/auth/magic-link-policy";
import { CheckoutError } from "../checkout/checkout-error";
import {
  type PaymentProviderAdapter,
  PaymentProviderError,
  type PaymentReference,
  type PaymentSessionInput,
  type PaymentVerification,
  type VerifyPayment,
} from "./payment-provider";
import { isMockPaymentPreview } from "./payment-provider-selection";

export const mockHostedPaymentPath = "/api/checkout/mock-payment";

type MockPaymentSession = typeof mockPaymentSessions.$inferSelect;

const mockPaymentCapabilitySchema = Schema.Struct({
  paymentId: Schema.String.check(
    Schema.isPattern(/^mock-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  ),
  token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});

export type MockPaymentCapability = typeof mockPaymentCapabilitySchema.Type;

type MockPaymentDecision = "approved" | "declined";

export const isMockPaymentCapability = Schema.is(mockPaymentCapabilitySchema);

const hashCapability = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const hasMatchingCapability = (session: MockPaymentSession, token: string) =>
  isMatchingSecret(hashCapability(token), session.capabilityHash);

const hasPaymentActivity = (session: MockPaymentSession) =>
  session.outcome !== "pending" || session.cancelledAt !== null;

const providerError = (message: string) => (cause: unknown) =>
  new PaymentProviderError({ message, cause });

const findPaymentSession = Effect.fn("mockPayment.findSession")(function* (
  db: WorkspaceDatabaseClient,
  paymentId: string
) {
  const [session] = yield* db
    .select()
    .from(mockPaymentSessions)
    .where(eq(mockPaymentSessions.paymentId, paymentId))
    .pipe(
      Effect.mapError(providerError("Could not read test payment session."))
    );
  return session;
});

export const authorizeMockPaymentSession = Effect.fn(
  "mockPayment.authorizeSession"
)(function* (capability: MockPaymentCapability) {
  if (!isMockPaymentPreview() || !isMockPaymentCapability(capability))
    return false;

  const { db } = yield* WorkspaceDatabase;
  const session = yield* findPaymentSession(db, capability.paymentId);
  return (
    session !== undefined && hasMatchingCapability(session, capability.token)
  );
});

export const decideMockPaymentSession = Effect.fn("mockPayment.decideSession")(
  function* (capability: MockPaymentCapability, decision: MockPaymentDecision) {
    if (!(yield* authorizeMockPaymentSession(capability))) return undefined;

    const { db } = yield* WorkspaceDatabase;
    const [decidedSession] = yield* db
      .update(mockPaymentSessions)
      .set({ outcome: decision, decidedAt: sql`now()` })
      .where(
        and(
          eq(mockPaymentSessions.paymentId, capability.paymentId),
          eq(mockPaymentSessions.outcome, "pending"),
          isNull(mockPaymentSessions.cancelledAt)
        )
      )
      .returning({ returnUrl: mockPaymentSessions.returnUrl })
      .pipe(Effect.mapError(providerError("Could not decide test payment.")));

    // The guarded UPDATE lets one decision win. Replays return through the
    // original callback without changing the authoritative outcome.
    if (decidedSession) return decidedSession.returnUrl;
    const session = yield* findPaymentSession(db, capability.paymentId);
    return session?.returnUrl;
  }
);

export const makeMockPaymentProvider = Effect.gen(function* () {
  const { db } = yield* WorkspaceDatabase;

  const requireSession = Effect.fn("mockPayment.requireSession")(function* ({
    providerOrderId,
  }: PaymentReference) {
    if (isMockPaymentPreview()) {
      const session = yield* findPaymentSession(db, providerOrderId);
      if (session) return session;
    }

    return yield* new PaymentProviderError({
      message: "Test payment session was not found.",
      notFound: true,
    });
  });

  const prepareSession = Effect.fn("mockPayment.prepareSession")(function* (
    input: PaymentSessionInput
  ) {
    const { email } = input.customer;
    if (
      !isMockPaymentPreview() ||
      !email ||
      !isSyntheticE2EEmailRecipient(email)
    ) {
      return yield* new CheckoutError({
        code: "checkout_failed",
        message: "Test payments require a synthetic account in preview.",
      });
    }

    const providerOrderId = `mock-${randomUUID()}`;
    const securityToken = randomBytes(32).toString("hex");
    const hostedPage = yield* Effect.try({
      try: () => new URL(mockHostedPaymentPath, input.resultUrl),
      catch: () =>
        new CheckoutError({
          code: "checkout_failed",
          message: "The test payment page URL could not be created.",
        }),
    });
    hostedPage.searchParams.set("paymentId", providerOrderId);
    hostedPage.searchParams.set("token", securityToken);

    const create = db
      .insert(mockPaymentSessions)
      .values({
        paymentId: providerOrderId,
        capabilityHash: hashCapability(securityToken),
        amountMinor: input.amount.value,
        currency: input.amount.currency,
        returnUrl: input.resultUrl,
      })
      .pipe(
        Effect.mapError(
          providerError("Could not create test payment session.")
        ),
        Effect.as({
          providerOrderId,
          securityToken,
          hostedPage: hostedPage.toString(),
        })
      );

    return { providerOrderId, create };
  });

  const lookup = Effect.fn("mockPayment.lookup")(function* (
    input: PaymentReference
  ) {
    const session = yield* requireSession(input);
    const canRetry =
      session.outcome === "declined" || session.cancelledAt !== null;
    const refund =
      session.refundedAmountMinor === null
        ? undefined
        : {
            amount: session.refundedAmountMinor,
            lastRefundedAt: session.refundedAt?.toString(),
            operationIds: [`mock-refund-${session.paymentId}`],
          };

    return {
      hasActivity: hasPaymentActivity(session),
      canRetry,
      ...(refund && { refund }),
    };
  });

  const verify = Effect.fn("mockPayment.verify")(function* (
    input: VerifyPayment
  ) {
    const session = yield* requireSession(input);
    const mismatches = [
      ...(hasMatchingCapability(session, input.securityToken)
        ? []
        : ["securityToken"]),
      ...(session.amountMinor === input.amount.value ? [] : ["amount"]),
      ...(session.currency === input.amount.currency ? [] : ["currency"]),
    ];
    const observation = {
      mismatches,
      hasActivity: hasPaymentActivity(session),
    };
    if (mismatches.length > 0)
      return {
        ...observation,
        status: "failure",
        terminalState: "failed",
        failureCode: "mock_payment_failed",
      } satisfies PaymentVerification;
    if (session.cancelledAt) {
      return {
        ...observation,
        status: "failure",
        providerStatus: "canceled",
        terminalState: "cancelled",
        failureCode: "mock_payment_cancelled",
      } satisfies PaymentVerification;
    }
    switch (session.outcome) {
      case "pending":
        return {
          ...observation,
          status: "pending",
          providerStatus: "pending",
        } satisfies PaymentVerification;
      case "approved":
        return {
          ...observation,
          status: "success",
          providerStatus: "succeeded",
          providerOperationId: session.paymentId,
        } satisfies PaymentVerification;
      case "declined":
        return {
          ...observation,
          status: "failure",
          providerStatus: "declined",
          terminalState: "failed",
          failureCode: "mock_payment_failed",
        } satisfies PaymentVerification;
    }
  });

  return {
    prepareSession,
    lookup,
    verify,
    unconfirmedSessionFailureCode: "mock_payment_session_unconfirmed",
  } satisfies PaymentProviderAdapter;
});
