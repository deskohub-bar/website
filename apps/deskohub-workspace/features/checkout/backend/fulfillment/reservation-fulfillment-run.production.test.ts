import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposReservationIdSchema,
  DotyposService,
} from "@deskohub/dotypos";
import { EmailDeliveryIdSchema } from "@deskohub/email";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { env, getAccountingDocumentSnapshotSecret } from "@/env";
import { ReservationInvoiceService } from "@/features/accounting/backend/reservation-invoice.service";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { Locale } from "@/features/i18n";
import { dotyposCustomerFixture } from "@/shared/testing/dotypos-customer.test-utils";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import type { IFulfillmentLedger } from "./fulfillment-ledger.repository";
import {
  customerAccessCodeFixture,
  fulfillmentDetailsFixture,
  fulfillmentOrderFixture,
  fulfillmentQueryFailure,
  fulfillmentReservationId,
} from "./reservation-fulfillment.test-utils";
import type { IWorkspaceReservationEmailService } from "./workspace-reservation-email.service";

mock.module("server-only", () => ({}));

// The workspace env object bakes VERCEL_ENV at first import, so the accepted
// delivery branch is exercised through a retroactive override of "@/env" that
// only replaces VERCEL_ENV and delegates every other field to the real env.
mock.module("@/env", () => ({
  env: new Proxy(env, {
    get: (target, key) =>
      key === "VERCEL_ENV" ? "production" : Reflect.get(target, key),
  }),
  getAccountingDocumentSnapshotSecret,
}));

const { WorkspaceCheckoutAccessCodeService } = await import(
  "@/features/checkout/backend/reservation/access-code.service"
);
const { ReservationFulfillment } = await import(
  "./reservation-fulfillment.service"
);
const { createCustomerEmailRecoveryIdempotencyKey } = await import(
  "./customer-email-idempotency-key"
);
const { WorkspaceReservationEmailService } = await import(
  "./workspace-reservation-email.service"
);
const { WorkspaceReservationRepository } = await import(
  "@/features/reservation/backend/workspace-reservation.repository"
);
const {
  FulfillmentLedger,
  WorkspaceReservationDeliveryGenerationSupersededError,
} = await import("./fulfillment-ledger.repository");
const { WorkspaceReservationStateError } = await import(
  "@/features/reservation/backend/workspace-reservation.repository"
);
const { WorkspaceReservationService } = await import(
  "@/features/reservation/backend/workspace-reservation.service"
);
const { CustomerEmailLocaleService, ReservationAuthorDirectory } = await import(
  "@/features/account"
);
// The directory returns no author details unless a test provides them.
const noReservationAuthors = Layer.mock(ReservationAuthorDirectory, {
  describe: () => Effect.succeed(new Map()),
});
const { recordCheckoutAnalytics } = await import(
  "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
);

describe("ReservationFulfillment.run production email acceptance", () => {
  test("records the accepted delivery id and leaves fulfillment awaiting the webhook", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "not_started",
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "confirmed",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      activeCustomerEmailDeliveryLocale: null,
      locale: "en-US",
    });
    const emailReservation = fulfillmentDetailsFixture(claimed, {
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-02T08:00:00.000Z"),
      placement: { table: { mode: "assigned", name: "12" } },
    });
    const customerEmailDeliveryId = EmailDeliveryIdSchema.make(
      "accepted-production-email-delivery"
    );
    const sendPaidReservationEmails = mock(() =>
      Effect.succeed(customerEmailDeliveryId)
    );
    const markAwaitingCustomerEmailDelivery = mock(() => Effect.void);
    const markFulfilled = mock(() =>
      Effect.die("production fulfillment must stay awaiting delivery")
    );
    const processInvoice = mock(() =>
      Effect.die("production acceptance must not process invoices")
    );

    const result = await Effect.gen(function* () {
      const service = yield* ReservationFulfillment;
      return yield* service.run(fulfillmentReservationId).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
              }),
              Layer.mock(FulfillmentLedger, {
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                markAwaitingCustomerEmailDelivery,
                markFulfilled,
                markFulfillmentFailed: mock(() =>
                  Effect.die("production acceptance must not fail fulfillment")
                ),
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() => Effect.succeed(emailReservation)),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails,
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock((input) =>
                  Effect.succeed(customerAccessCodeFixture(input))
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: processInvoice,
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    const { env: productionEnv } = await import("@/env");
    expect(productionEnv.VERCEL_ENV).toBe("production");
    expect(result._tag).toBe("Success");
    expect(sendPaidReservationEmails).toHaveBeenCalledWith({
      reservation: emailReservation,
      customerEmailLocale: "en-US",
      author: null,
      customerEmailIdempotencyKey:
        "workspace-paid-reservation-access-reservation-id",
    });
    expect(markAwaitingCustomerEmailDelivery).toHaveBeenCalledWith({
      id: "reservation-id",
      customerEmailDeliveryId,
      expectedActiveCustomerEmailDeliveryId: null,
    });
    expect(markFulfilled).not.toHaveBeenCalled();
    expect(processInvoice).not.toHaveBeenCalled();
  });

  test("completes a synthetic booking on Console acceptance without awaiting a webhook", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "not_started",
      locale: "en-US",
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "confirmed",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
    });
    const emailReservation = fulfillmentDetailsFixture(claimed, {
      customer: dotyposCustomerFixture(claimed.dotyposCustomerId, {
        email: testEmailAddress("delivered+cowork-basic-1"),
      }),
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-02T08:00:00.000Z"),
      placement: { table: { mode: "assigned", name: "12" } },
    });
    const customerEmailDeliveryId = EmailDeliveryIdSchema.make(
      "console-production-email-delivery"
    );
    const sendPaidReservationEmails = mock(() =>
      Effect.succeed(customerEmailDeliveryId)
    );
    const markAwaitingCustomerEmailDelivery = mock(() =>
      Effect.die("Console acceptance must not await a webhook")
    );
    const markFulfilled = mock(() => Effect.void);
    const processInvoice = mock(() => Effect.void);

    const result = await Effect.gen(function* () {
      const service = yield* ReservationFulfillment;
      return yield* service.run(fulfillmentReservationId).pipe(Effect.result);
    }).pipe(
      Effect.provide(
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
              }),
              Layer.mock(FulfillmentLedger, {
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                markAwaitingCustomerEmailDelivery,
                markFulfilled,
                markFulfillmentFailed: mock(() =>
                  Effect.die("production acceptance must not fail fulfillment")
                ),
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() => Effect.succeed(emailReservation)),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails,
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock((input) =>
                  Effect.succeed(customerAccessCodeFixture(input))
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: processInvoice,
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    const { env: productionEnv } = await import("@/env");
    expect(productionEnv.VERCEL_ENV).toBe("production");
    expect(result._tag).toBe("Success");
    expect(sendPaidReservationEmails).toHaveBeenCalledWith({
      reservation: emailReservation,
      customerEmailLocale: "en-US",
      author: null,
      customerEmailIdempotencyKey:
        "workspace-paid-reservation-access-reservation-id",
    });
    expect(markAwaitingCustomerEmailDelivery).not.toHaveBeenCalled();
    expect(markFulfilled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        customerEmailDeliveryId,
      })
    );
    expect(processInvoice).toHaveBeenCalledWith({
      reservationId: "reservation-id",
    });
  });

  test("retries a bounced delivery with a fresh idempotency key and attaches the new send", async () => {
    const priorDeliveryId = EmailDeliveryIdSchema.make(
      "bounced-customer-email-delivery"
    );
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "failed",
      activeCustomerEmailDeliveryId: priorDeliveryId,
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "confirmed",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      activeCustomerEmailDeliveryLocale: null,
      locale: "en-US",
    });
    const emailReservation = fulfillmentDetailsFixture(claimed, {
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-02T08:00:00.000Z"),
      placement: { table: { mode: "assigned", name: "12" } },
    });
    const recoveredDeliveryId = EmailDeliveryIdSchema.make(
      "recovered-customer-email-delivery"
    );
    const sendPaidReservationEmails = mock(() =>
      Effect.succeed(recoveredDeliveryId)
    );
    const markAwaitingCustomerEmailDelivery = mock(() => Effect.void);
    const markFulfilled = mock(() =>
      Effect.die("production recovery must stay awaiting delivery")
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* ReservationFulfillment;
          return yield* service
            .run(fulfillmentReservationId)
            .pipe(Effect.result);
        }),
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
              }),
              Layer.mock(FulfillmentLedger, {
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                markAwaitingCustomerEmailDelivery,
                markFulfilled,
                markFulfillmentFailed: mock(() =>
                  Effect.die("production recovery must not fail fulfillment")
                ),
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() => Effect.succeed(emailReservation)),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails,
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock((input) =>
                  Effect.succeed(customerAccessCodeFixture(input))
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("production acceptance must not process invoices")
                ),
              })
            )
          )
        )
      )
    );

    expect(result._tag).toBe("Success");
    expect(sendPaidReservationEmails).toHaveBeenCalledWith({
      reservation: emailReservation,
      customerEmailLocale: "en-US",
      author: null,
      customerEmailIdempotencyKey:
        createCustomerEmailRecoveryIdempotencyKey(priorDeliveryId),
    });
    expect(markAwaitingCustomerEmailDelivery).toHaveBeenCalledWith({
      id: "reservation-id",
      customerEmailDeliveryId: recoveredDeliveryId,
      expectedActiveCustomerEmailDeliveryId: priorDeliveryId,
    });
    expect(markFulfilled).not.toHaveBeenCalled();
  });

  test("keeps the retained locale for an accepted-but-unrecorded send when the preference changes", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "not_started",
    });
    const initialClaimed = fulfillmentOrderFixture({
      ...order,
      locale: "en-US",
      reservationState: "confirmed",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      activeCustomerEmailDeliveryLocale: null,
    });
    // The first accepted send recorded its delivery attachment failure, so the
    // generation stays open with its retained locale.
    const retainedClaimed = fulfillmentOrderFixture({
      ...initialClaimed,
      activeCustomerEmailDeliveryLocale: "cs-CZ" as const,
    });
    const emailReservation = fulfillmentDetailsFixture(retainedClaimed, {
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-02T08:00:00.000Z"),
      placement: { table: { mode: "assigned", name: "12" } },
    });
    const claims = [initialClaimed, retainedClaimed];
    const claimPaidFulfillment = mock(() =>
      Effect.succeed(claims.shift() ?? null)
    );
    // The customer changed the saved preference between the two attempts.
    const preferenceLocales: Locale[] = ["cs-CZ", "en-US"];
    const byDotyposCustomer = mock(() => {
      const locale = requireValue(preferenceLocales.shift(), "fixture locale");
      return Effect.succeed({ kind: "account", locale } as const);
    });
    const retainInputs: Parameters<
      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
    >[0][] = [];
    const retainActiveCustomerEmailDeliveryLocale = mock(
      (
        input: Parameters<
          IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
        >[0]
      ) => {
        retainInputs.push(input);
        return Effect.succeed(input.locale);
      }
    );
    const attachmentFailure = fulfillmentQueryFailure(
      "update reservations",
      "synthetic delivery attachment failure before commit"
    );
    let attachAttempts = 0;
    const markAwaitingCustomerEmailDelivery = mock(() => {
      attachAttempts += 1;
      return attachAttempts === 1
        ? Effect.fail(attachmentFailure)
        : Effect.void;
    });
    const sendInputs: unknown[] = [];
    const sendPaidReservationEmails = mock(
      (
        input: Parameters<
          IWorkspaceReservationEmailService["sendPaidReservationEmails"]
        >[0]
      ) => {
        sendInputs.push(input);
        return Effect.succeed(
          EmailDeliveryIdSchema.make(`accepted-${sendInputs.length}`)
        );
      }
    );

    const runs = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* ReservationFulfillment;
          const first = yield* service
            .run(fulfillmentReservationId)
            .pipe(Effect.result);
          const second = yield* service
            .run(fulfillmentReservationId)
            .pipe(Effect.result);
          return { first, second };
        }),
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
              }),
              Layer.mock(FulfillmentLedger, {
                claimPaidFulfillment,
                retainActiveCustomerEmailDeliveryLocale,
                markAwaitingCustomerEmailDelivery,
                markFulfilled: mock(() =>
                  Effect.die(
                    "production fulfillment must stay awaiting delivery"
                  )
                ),
                markFulfillmentFailed: mock(() => Effect.void),
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer,
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() => Effect.succeed(emailReservation)),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails,
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock((input) =>
                  Effect.succeed(customerAccessCodeFixture(input))
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("production acceptance must not process invoices")
                ),
              })
            )
          )
        )
      )
    );

    expect(runs.first).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WorkspacePaidFulfillmentError",
        failureCode: "fulfillment_completion_failed",
        cause: attachmentFailure,
      },
    });
    expect(runs.second._tag).toBe("Success");
    expect(byDotyposCustomer).toHaveBeenCalledTimes(1);
    expect(retainInputs).toEqual([
      {
        id: fulfillmentReservationId,
        locale: "cs-CZ",
        expectedActiveCustomerEmailDeliveryId: null,
      },
    ]);
    expect(sendInputs).toHaveLength(2);
    expect(sendInputs[0]).toEqual({
      reservation: emailReservation,
      customerEmailLocale: "cs-CZ",
      author: null,
      customerEmailIdempotencyKey:
        "workspace-paid-reservation-access-reservation-id",
    });
    expect(sendInputs[1]).toEqual(sendInputs[0]);
  });

  test("treats a recording superseded by a newer delivery generation as a no-op without failing fulfillment", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "not_started",
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "confirmed",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      activeCustomerEmailDeliveryLocale: null,
      locale: "en-US",
    });
    const emailReservation = fulfillmentDetailsFixture(claimed, {
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-02T08:00:00.000Z"),
      placement: { table: { mode: "assigned", name: "12" } },
    });
    // A newer recovery generation already recorded its delivery, so this
    // old-generation recording is rejected by the repository's generation
    // guard instead of clobbering the newer generation.
    const supersededError =
      new WorkspaceReservationDeliveryGenerationSupersededError({
        operation: "workspaceReservations.markAwaitingCustomerEmailDelivery",
        reservationId: fulfillmentReservationId,
        expectedActiveCustomerEmailDeliveryId: null,
        activeCustomerEmailDeliveryId: EmailDeliveryIdSchema.make(
          "newer-generation-delivery"
        ),
      });
    const markAwaitingCustomerEmailDelivery = mock(() =>
      Effect.fail(supersededError)
    );
    const markFulfillmentFailed = mock(() =>
      Effect.die("a superseded recording must not fail fulfillment")
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* ReservationFulfillment;
          return yield* service
            .run(fulfillmentReservationId)
            .pipe(Effect.result);
        }),
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
              }),
              Layer.mock(FulfillmentLedger, {
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                markAwaitingCustomerEmailDelivery,
                markFulfilled: mock(() =>
                  Effect.die(
                    "production fulfillment must stay awaiting delivery"
                  )
                ),
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() => Effect.succeed(emailReservation)),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails: mock(() =>
                  Effect.succeed(EmailDeliveryIdSchema.make("stale-delivery"))
                ),
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock((input) =>
                  Effect.succeed(customerAccessCodeFixture(input))
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("production acceptance must not process invoices")
                ),
              })
            )
          )
        )
      )
    );

    expect(result._tag).toBe("Success");
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
  });

  test("fails fulfillment when the delivery recording rejects for a non-supersession reason", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "not_started",
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "confirmed",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      activeCustomerEmailDeliveryLocale: null,
      locale: "en-US",
    });
    const emailReservation = fulfillmentDetailsFixture(claimed, {
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-02T08:00:00.000Z"),
      placement: { table: { mode: "assigned", name: "12" } },
    });
    // The reservation is no longer claimable for recording even though the
    // delivery generation still matches, so this is a real invalid-state
    // failure, not a superseded generation.
    const stateError = new WorkspaceReservationStateError({
      operation: "workspaceReservations.markAwaitingCustomerEmailDelivery",
      reservationId: fulfillmentReservationId,
      message:
        "Only processing paid reservations can await customer email delivery.",
    });
    const markAwaitingCustomerEmailDelivery = mock(() =>
      Effect.fail(stateError)
    );
    const markFulfillmentFailed = mock(() => Effect.void);

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* ReservationFulfillment;
          return yield* service
            .run(fulfillmentReservationId)
            .pipe(Effect.result);
        }),
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
              }),
              Layer.mock(FulfillmentLedger, {
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                markAwaitingCustomerEmailDelivery,
                markFulfilled: mock(() =>
                  Effect.die(
                    "production fulfillment must stay awaiting delivery"
                  )
                ),
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() => Effect.succeed(emailReservation)),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails: mock(() =>
                  Effect.succeed(
                    EmailDeliveryIdSchema.make("accepted-delivery")
                  )
                ),
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock((input) =>
                  Effect.succeed(customerAccessCodeFixture(input))
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("production acceptance must not process invoices")
                ),
              })
            )
          )
        )
      )
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WorkspacePaidFulfillmentError",
        failureCode: "fulfillment_completion_failed",
        cause: stateError,
      },
    });
    expect(markFulfillmentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        failureCode: "fulfillment_completion_failed",
      })
    );
  });
});
