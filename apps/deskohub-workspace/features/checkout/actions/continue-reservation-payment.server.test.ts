import { expect, mock, spyOn, test } from "bun:test";
import * as qrCode from "@deskohub/qr-code";
import { Clock, Effect, Layer } from "effect";
import { CustomerAccountReservationOwnership } from "@/features/account/backend/customer-account-reservation-ownership";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { CheckoutService } from "@/features/checkout/backend/checkout/checkout.service";
import { readAuthorPaymentStatus } from "@/features/checkout/backend/checkout/public-reservation-payment-status.server";
import { FioAccounts } from "@/features/checkout/backend/fio/fio-accounts.service";
import { QrPaymentRepository } from "@/features/checkout/backend/repositories/qr-payment.repository";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import { continueReservationPaymentForAuthor } from "./continue-reservation-payment.server";

const orderId = workspaceReservationIdSchema.make(
  "658d5a17-1ccc-4d97-baab-6cbb015125ca"
);
const author = customerAccountIdSchema.make("account-author");
const other = customerAccountIdSchema.make("other-account");
const pinnedKey = "synthetic-pinned";

const scenario = ({
  accountId = author,
  expired = false,
  paid = false,
  qrStarted = false,
  windowExpiresAt,
}: {
  readonly accountId?: typeof author;
  readonly expired?: boolean;
  readonly paid?: boolean;
  readonly qrStarted?: boolean;
  readonly windowExpiresAt?: Temporal.Instant;
} = {}) => {
  const resumeReservationPayment = mock(() =>
    Effect.succeed({
      status: "redirect" as const,
      orderId,
      redirectUrl: "https://payments.example.test/same-hosted-session",
    })
  );
  const expiresAt =
    windowExpiresAt ??
    Temporal.Now.instant().add({ minutes: expired ? -1 : 1 });
  const qrAttemptId = paymentAttemptIdSchema.make("attempt-qr");
  const findPaymentWindow = mock(() =>
    Effect.succeed({
      orderId: standaloneReservationOrderId(orderId),
      accountKey: pinnedKey,
      expiresAt,
      cardAttemptId: null,
      qrAttemptId: qrStarted ? qrAttemptId : null,
    })
  );
  const services = Layer.mergeAll(
    Layer.mock(CustomerAccountReservationOwnership, {
      activeAccountId: Effect.succeed(accountId),
    }),
    Layer.mock(WorkspaceReservationRepository, {
      findById: () =>
        Effect.succeed(
          workspaceReservationFixture({
            id: orderId,
            authorAccountId: author,
            reservationState: "held",
            paymentState: paid ? "paid" : "pending",
            fulfillmentState: "not_started",
            activePaymentAttemptId:
              paymentAttemptIdSchema.make("synthetic-attempt"),
          })
        ),
    }),
    Layer.mock(QrPaymentRepository, {
      findPaymentWindow,
      findForReservation: () =>
        Effect.succeed(
          qrStarted
            ? {
                orderId: standaloneReservationOrderId(orderId),
                attemptId: qrAttemptId,
                accountKey: pinnedKey,
                amount: { value: 45050, currency: "CZK", exponent: 2 },
                variableSymbol: "0000001234",
                expiresAt,
              }
            : null
        ),
    }),
    Layer.mock(FioAccounts, {
      getDefaultReceivingAccount: () => ({
        accountKey: "other-default",
        accountNumber: "999",
        bankCode: "0600",
      }),
      getReceivingAccountDisplay: (accountKey) =>
        accountKey === pinnedKey
          ? { accountKey, accountNumber: "123", bankCode: "0600" }
          : undefined,
    }),
    Layer.mock(CheckoutService, { resumeReservationPayment })
  );
  const effect = continueReservationPaymentForAuthor({
    locale: "en-US",
    orderId,
    method: "card",
  }).pipe(Effect.provide(services));
  const readStatus = readAuthorPaymentStatus(orderId, "en-US").pipe(
    Effect.provide(services)
  );
  return {
    effect,
    expiresAt,
    findPaymentWindow,
    readStatus,
    resumeReservationPayment,
  };
};

test("projects the pinned QR amount, reference, account and shared deadline", async () => {
  const { readStatus, expiresAt } = scenario({ qrStarted: true });
  const result = await Effect.runPromise(readStatus);
  expect(result?.qrPayment).toEqual({
    accountNumber: "123/0600",
    amount: expect.stringMatching(/CZK\s450\.50/),
    deadline: expect.any(String),
    expiresAt: expiresAt.toString(),
    qrCodeSource: expect.stringMatching(/^data:image\/png;base64,iVBORw0KGgo/),
    variableSymbol: "0000001234",
  });
});

const checkoutClock = (now: () => Temporal.Instant) => {
  const clock = Effect.runSync(Clock.clockWith(Effect.succeed));
  return {
    currentTimeMillis: Effect.sync(() => now().epochMilliseconds),
    currentTimeMillisUnsafe: () => now().epochMilliseconds,
    currentTimeNanos: Effect.sync(() => now().epochNanoseconds),
    currentTimeNanosUnsafe: () => now().epochNanoseconds,
    monotonicTimeNanos: clock.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    sleep: (delay: Parameters<typeof clock.sleep>[0]) => clock.sleep(delay),
  };
};

test("discards QR details when generation crosses the precise cutoff", async () => {
  const windowExpiresAt = Temporal.Instant.from("2026-11-20T13:00:00.123400Z");
  let now = Temporal.Instant.from("2026-11-20T13:00:00.123100Z");
  const generatePng = qrCode.generateQrCodePngBuffer;
  const renderQr = spyOn(qrCode, "generateQrCodePngBuffer").mockImplementation(
    async (...args) => {
      const png = await generatePng(...args);
      now = Temporal.Instant.from("2026-11-20T13:00:00.123900Z");
      return png;
    }
  );
  try {
    const { readStatus } = scenario({ qrStarted: true, windowExpiresAt });
    expect(
      await Effect.runPromise(
        readStatus.pipe(
          Effect.provideService(
            Clock.Clock,
            checkoutClock(() => now)
          )
        )
      )
    ).toBeUndefined();
    expect(renderQr).toHaveBeenCalledTimes(1);
  } finally {
    renderQr.mockRestore();
  }
});

test("hides QR details and denies continuation after the shared cutoff within the same millisecond", async () => {
  const windowExpiresAt = Temporal.Instant.from("2026-11-20T13:00:00.123400Z");
  const now = Temporal.Instant.from("2026-11-20T13:00:00.123900Z");
  const fixedClock = checkoutClock(() => now);
  const { effect, readStatus, resumeReservationPayment } = scenario({
    qrStarted: true,
    windowExpiresAt,
  });

  expect(
    await Effect.runPromise(
      readStatus.pipe(Effect.provideService(Clock.Clock, fixedClock))
    )
  ).toBeUndefined();
  expect(
    await Effect.runPromise(
      effect.pipe(Effect.provideService(Clock.Clock, fixedClock))
    )
  ).toEqual({ status: "unavailable" });
  expect(resumeReservationPayment).not.toHaveBeenCalled();
});

test("uses the original reservation and pinned account when its author resumes card", async () => {
  const { effect, resumeReservationPayment } = scenario();
  expect(await Effect.runPromise(effect)).toEqual({
    status: "redirect",
    redirectUrl: "https://payments.example.test/same-hosted-session",
  });
  expect(resumeReservationPayment).toHaveBeenCalledWith(
    { reservationId: orderId, method: "card", fio: { accountKey: pinnedKey } },
    "en-US"
  );
});

test("denies continuation for another account before reading the payment window", async () => {
  const { effect, findPaymentWindow, resumeReservationPayment } = scenario({
    accountId: other,
  });
  expect(await Effect.runPromise(effect)).toEqual({ status: "unavailable" });
  expect(findPaymentWindow).not.toHaveBeenCalled();
  expect(resumeReservationPayment).not.toHaveBeenCalled();
});

test.each([{ expired: true }, { paid: true }])(
  "denies continuation for a closed reservation (%o)",
  async (flags) => {
    const { effect, resumeReservationPayment } = scenario(flags);
    expect(await Effect.runPromise(effect)).toEqual({ status: "unavailable" });
    expect(resumeReservationPayment).not.toHaveBeenCalled();
  }
);
