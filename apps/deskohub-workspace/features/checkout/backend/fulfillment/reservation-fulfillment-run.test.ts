import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposReservationCancelledError,
  DotyposReservationIdSchema,
  DotyposService,
} from "@deskohub/dotypos";
import { type EmailDeliveryId, EmailDeliveryIdSchema } from "@deskohub/email";
import { EmailServiceError } from "@deskohub/email/backend/service";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer } from "effect";
import { env, getAccountingDocumentSnapshotSecret } from "@/env";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { ReservationInvoiceService } from "@/features/accounting/backend/reservation-invoice.service";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { IFulfillmentLedger } from "./fulfillment-ledger.repository";
import {
  confirmDotyposReservationFixture,
  customerAccessCodeFixture,
  fulfillmentDetailsFixture,
  fulfillmentOrderFixture,
  fulfillmentQueryFailure,
  fulfillmentReservationId,
} from "./reservation-fulfillment.test-utils";
import type { IWorkspaceReservationEmailService } from "./workspace-reservation-email.service";

mock.module("server-only", () => ({}));

// Bun module mocks are process-wide across files in a multi-file run, and the
// production acceptance test pins "@/env" to VERCEL_ENV "production". Pin it
// back here so this file always exercises the non-production fulfillment
// branch regardless of test-file ordering.
mock.module("@/env", () => ({
  env: new Proxy(env, {
    get: (target, key) =>
      key === "VERCEL_ENV" ? undefined : Reflect.get(target, key),
  }),
  getAccountingDocumentSnapshotSecret,
}));

const { WorkspaceCheckoutAccessCodeService } = await import(
  "@/features/checkout/backend/reservation/access-code.service"
);

const { PAID_FULFILLMENT_PROCESSING_RETRY_AFTER_MS, ReservationFulfillment } =
  await import("./reservation-fulfillment.service");
const { createCustomerEmailRecoveryIdempotencyKey } = await import(
  "./customer-email-idempotency-key"
);
const { WorkspaceReservationEmailService } = await import(
  "./workspace-reservation-email.service"
);
const { WorkspaceReservationRepository } = await import(
  "@/features/reservation/backend/workspace-reservation.repository"
);
const { FulfillmentLedger } = await import("./fulfillment-ledger.repository");
const { WorkspaceReservationService, WorkspaceReservationDetailsError } =
  await import("@/features/reservation/backend/workspace-reservation.service");
const {
  CustomerEmailLocaleService,
  ReservationAuthorDirectory,
  ReservationAuthorReadError,
} = await import("@/features/account");
// The directory returns no author details unless a test provides them.
const noReservationAuthors = Layer.mock(ReservationAuthorDirectory, {
  describe: () => Effect.succeed(new Map()),
});
const { recordCheckoutAnalytics } = await import(
  "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
);

describe("ReservationFulfillment.run", () => {
  test("retries stale processing paid orders and completes non-production fulfillment after send acceptance", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "processing",
      updatedAt: Temporal.Now.instant().subtract({
        milliseconds: PAID_FULFILLMENT_PROCESSING_RETRY_AFTER_MS + 1000,
      }),
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
    const claimPaidFulfillment = mock(() => Effect.succeed(claimed));
    const confirmReservation = mock(() =>
      Effect.die("already confirmed reservations do not call Dotypos")
    );
    const markReservationConfirmed = mock(() =>
      Effect.die("already confirmed reservations do not update confirmation")
    );
    const deliverySteps: string[] = [];
    const customerEmailDeliveryId = EmailDeliveryIdSchema.make(
      "accepted-customer-email-delivery"
    );
    const sendPaidReservationEmails = mock(() =>
      Effect.sync(() => {
        deliverySteps.push("email");
        return customerEmailDeliveryId;
      })
    );
    const resolveCustomerAccessCode = mock(
      (input: Parameters<typeof customerAccessCodeFixture>[0]) =>
        Effect.sync(() => {
          deliverySteps.push("access");
          return customerAccessCodeFixture(input);
        })
    );
    const markFulfilled = mock(() => Effect.void);
    const processInvoice = mock(() => Effect.void);

    await Effect.gen(function* () {
      const service = yield* ReservationFulfillment;
      yield* service.run(fulfillmentReservationId);
    }).pipe(
      Effect.provide(
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
                markReservationConfirmed,
              }),
              Layer.mock(FulfillmentLedger, {
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment,
                markFulfilled,
                markFulfillmentFailed: mock(() => Effect.void),
              }),
              Layer.mock(DotyposService, {
                confirmReservation,
              }),
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
                resolveCustomerAccessCode,
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

    expect(claimPaidFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        staleProcessingBefore: expect.any(Temporal.Instant),
      })
    );
    expect(confirmReservation).not.toHaveBeenCalled();
    expect(markReservationConfirmed).not.toHaveBeenCalled();
    expect(sendPaidReservationEmails).toHaveBeenCalledWith({
      reservation: emailReservation,
      customerEmailLocale: "en-US",
      author: null,
      customerEmailIdempotencyKey:
        "workspace-paid-reservation-access-reservation-id",
    });
    expect(resolveCustomerAccessCode).toHaveBeenCalledWith({
      reservationId: emailReservation.id,
      dotyposReservationId: emailReservation.dotyposReservationId,
      reservedFrom: emailReservation.reservedFrom,
      reservedUntil: emailReservation.reservedUntil,
    });
    expect(deliverySteps).toEqual(["access", "email"]);
    expect(markFulfilled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reservation-id" })
    );
    expect(processInvoice).toHaveBeenCalledWith({
      reservationId: "reservation-id",
    });
  });

  test("issues the door code of an early-setup meeting room from its setup start", async () => {
    const order = fulfillmentOrderFixture({
      reservationDetails: { kind: "meeting-room", earlySetup: true },
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "processing",
      updatedAt: Temporal.Now.instant().subtract({
        milliseconds: PAID_FULFILLMENT_PROCESSING_RETRY_AFTER_MS + 1000,
      }),
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
      setupFrom: Temporal.Instant.from("2026-07-01T07:45:00.000Z"),
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-01T10:00:00.000Z"),
    });
    const claimPaidFulfillment = mock(() => Effect.succeed(claimed));
    const confirmReservation = mock(() =>
      Effect.die("already confirmed reservations do not call Dotypos")
    );
    const markReservationConfirmed = mock(() =>
      Effect.die("already confirmed reservations do not update confirmation")
    );
    const deliverySteps: string[] = [];
    const customerEmailDeliveryId = EmailDeliveryIdSchema.make(
      "accepted-customer-email-delivery"
    );
    const sendPaidReservationEmails = mock(() =>
      Effect.sync(() => {
        deliverySteps.push("email");
        return customerEmailDeliveryId;
      })
    );
    const resolveCustomerAccessCode = mock(
      (input: Parameters<typeof customerAccessCodeFixture>[0]) =>
        Effect.sync(() => {
          deliverySteps.push("access");
          return customerAccessCodeFixture(input);
        })
    );
    const markFulfilled = mock(() => Effect.void);
    const processInvoice = mock(() => Effect.void);

    await Effect.gen(function* () {
      const service = yield* ReservationFulfillment;
      yield* service.run(fulfillmentReservationId);
    }).pipe(
      Effect.provide(
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
                markReservationConfirmed,
              }),
              Layer.mock(FulfillmentLedger, {
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment,
                markFulfilled,
                markFulfillmentFailed: mock(() => Effect.void),
              }),
              Layer.mock(DotyposService, {
                confirmReservation,
              }),
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
                resolveCustomerAccessCode,
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

    expect(resolveCustomerAccessCode).toHaveBeenCalledWith({
      reservationId: emailReservation.id,
      dotyposReservationId: emailReservation.dotyposReservationId,
      reservedFrom: emailReservation.setupFrom,
      reservedUntil: emailReservation.reservedUntil,
    });
  });

  test("hands the reservation's author to the first paid emails only and still fulfills when the author can't be read", async () => {
    const author = {
      kind: "active",
      accountId: customerAccountIdSchema.make("author-account-id"),
      dotyposCustomerId: DotyposCustomerIdSchema.make(
        "author-dotypos-customer-id"
      ),
      email: testEmailAddress("author"),
      locale: "cs-CZ",
    } as const;
    const fulfill = async (
      describe: () => ReturnType<
        (typeof ReservationAuthorDirectory)["Service"]["describe"]
      >,
      priorCustomerEmailDeliveryId: EmailDeliveryId | null = null
    ) => {
      const order = fulfillmentOrderFixture({
        activePaymentAttemptId:
          paymentAttemptIdSchema.make("payment-attempt-id"),
        paymentState: "paid",
        fulfillmentState: priorCustomerEmailDeliveryId
          ? "failed"
          : "not_started",
        activeCustomerEmailDeliveryId: priorCustomerEmailDeliveryId,
      });
      const claimed = fulfillmentOrderFixture({
        ...order,
        authorAccountId: author.accountId,
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
      });
      const sendPaidReservationEmails = mock(() =>
        Effect.succeed(
          EmailDeliveryIdSchema.make("accepted-customer-email-delivery")
        )
      );
      const markFulfilled = mock(() => Effect.void);
      const describeAuthors = mock(describe);

      await Effect.gen(function* () {
        const service = yield* ReservationFulfillment;
        yield* service.run(fulfillmentReservationId);
      }).pipe(
        Effect.provide(
          ReservationFulfillment.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ReservationAuthorDirectory, {
                  describe: describeAuthors,
                }),
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
                  markFulfilled,
                  markFulfillmentFailed: mock(() => Effect.void),
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
                  issueAfterFulfillment: mock(() => Effect.void),
                })
              )
            )
          )
        ),
        Effect.runPromise
      );

      return { sendPaidReservationEmails, markFulfilled, describeAuthors };
    };

    const described = await fulfill(() =>
      Effect.succeed(new Map([[author.accountId, author]]))
    );
    expect(described.sendPaidReservationEmails).toHaveBeenCalledWith(
      expect.objectContaining({ author })
    );
    expect(described.markFulfilled).toHaveBeenCalled();

    const unreadable = await fulfill(() =>
      Effect.fail(
        new ReservationAuthorReadError({ code: "reservation-author.read" })
      )
    );
    expect(unreadable.sendPaidReservationEmails).toHaveBeenCalledWith(
      expect.objectContaining({ author: null })
    );
    expect(unreadable.markFulfilled).toHaveBeenCalled();

    const recovery = await fulfill(
      () => Effect.succeed(new Map([[author.accountId, author]])),
      EmailDeliveryIdSchema.make("bounced-customer-email-delivery")
    );
    expect(recovery.describeAuthors).not.toHaveBeenCalled();
    expect(recovery.sendPaidReservationEmails).toHaveBeenCalledWith(
      expect.objectContaining({ author: null })
    );
  });

  test("confirms held paid orders, sends emails, and completes non-production fulfillment", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "not_started",
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "held",
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
    const confirmReservation = mock(confirmDotyposReservationFixture);
    const markReservationConfirmed = mock(() => Effect.void);
    const sendPaidReservationEmails = mock(() =>
      Effect.succeed(
        EmailDeliveryIdSchema.make("accepted-customer-email-delivery")
      )
    );
    const markFulfilled = mock(() => Effect.void);
    const processInvoice = mock(() => Effect.void);

    await Effect.gen(function* () {
      const service = yield* ReservationFulfillment;
      yield* service.run(fulfillmentReservationId);
    }).pipe(
      Effect.provide(
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
                markReservationConfirmed,
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
                markFulfilled,
                markFulfillmentFailed: mock(() => Effect.void),
              }),
              Layer.mock(DotyposService, {
                confirmReservation,
              }),
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

    expect(confirmReservation).toHaveBeenCalledWith(
      DotyposReservationIdSchema.make("dotypos-reservation-id")
    );
    expect(markReservationConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reservation-id" })
    );
    expect(sendPaidReservationEmails).toHaveBeenCalledWith({
      reservation: emailReservation,
      customerEmailLocale: "en-US",
      author: null,
      customerEmailIdempotencyKey:
        "workspace-paid-reservation-access-reservation-id",
    });
    expect(markFulfilled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "reservation-id" })
    );
    expect(processInvoice).toHaveBeenCalledWith({
      reservationId: "reservation-id",
    });
  });

  test("reuses the Open Space table list and idempotency key after an uncertain send", async () => {
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
      reservationDetails: {
        kind: "cowork",
        entryTier: "open-space",
        coffee: false,
      },
    });
    const emailReservation = fulfillmentDetailsFixture(claimed, {
      reservedFrom: Temporal.Instant.from("2026-07-01T08:00:00.000Z"),
      reservedUntil: Temporal.Instant.from("2026-07-02T08:00:00.000Z"),
      placement: { table: { mode: "shared", name: "12" } },
    });
    let availableTableNames = "12";
    let retainedTableNames: string | null = null;
    const retainActiveCustomerEmailDeliveryOpenSpaceTables = mock<
      IFulfillmentLedger["retainActiveCustomerEmailDeliveryOpenSpaceTables"]
    >((input) => {
      retainedTableNames ??= input.tableNames;
      return Effect.succeed(retainedTableNames);
    });
    const sendFailure = new EmailServiceError(
      "synthetic email provider failure"
    );
    const sendInputs: unknown[] = [];
    let sendAttempts = 0;
    const sendPaidReservationEmails = mock(
      (
        input: Parameters<
          IWorkspaceReservationEmailService["sendPaidReservationEmails"]
        >[0]
      ) => {
        sendInputs.push(input);
        sendAttempts += 1;
        return sendAttempts === 1
          ? Effect.fail(sendFailure)
          : Effect.succeed(EmailDeliveryIdSchema.make("recovered-delivery"));
      }
    );
    const markFulfillmentFailed = mock(() => Effect.void);
    const markFulfilled = mock(() => Effect.void);

    const runs = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* ReservationFulfillment;
          const first = yield* service
            .run(fulfillmentReservationId)
            .pipe(Effect.result);
          availableTableNames = "12–16";
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
                retainActiveCustomerEmailDeliveryLocale: mock(
                  (
                    input: Parameters<
                      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
                    >[0]
                  ) => Effect.succeed(input.locale)
                ),
                claimPaidFulfillment: mock(() =>
                  Effect.succeed({
                    ...claimed,
                    activeCustomerEmailDeliveryOpenSpaceTables:
                      retainedTableNames,
                  })
                ),
                retainActiveCustomerEmailDeliveryOpenSpaceTables,
                markFulfilled,
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock<
                  typeof WorkspaceReservationService.Service.getReservation
                >((_id, options) =>
                  Effect.succeed({
                    ...emailReservation,
                    placement: options?.requireOpenSpaceTableNames
                      ? {
                          table: {
                            mode: "shared",
                            name: availableTableNames,
                          },
                        }
                      : {},
                  })
                ),
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
                issueAfterFulfillment: mock(() => Effect.void),
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
        failureCode: "fulfillment_email_failed",
      },
    });
    expect(markFulfillmentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        failureCode: "fulfillment_email_failed",
      })
    );
    expect(sendInputs).toHaveLength(2);
    expect(sendInputs[0]).toEqual({
      reservation: emailReservation,
      customerEmailLocale: "en-US",
      author: null,
      customerEmailIdempotencyKey:
        createCustomerEmailRecoveryIdempotencyKey(priorDeliveryId),
    });
    expect(sendInputs[1]).toEqual(sendInputs[0]);
    expect(
      retainActiveCustomerEmailDeliveryOpenSpaceTables
    ).toHaveBeenCalledTimes(1);
    expect(
      retainActiveCustomerEmailDeliveryOpenSpaceTables
    ).toHaveBeenCalledWith({
      id: "reservation-id",
      expectedActiveCustomerEmailDeliveryId: priorDeliveryId,
      tableNames: "12",
    });
    expect(sendInputs[0]).not.toEqual({
      reservation: emailReservation,
      customerEmailLocale: "en-US",
      customerEmailIdempotencyKey:
        "workspace-paid-reservation-access-reservation-id",
    });
    expect(runs.second._tag).toBe("Success");
    // The recovered send supersedes the bounced one, so a stale webhook for
    // the prior delivery can no longer match the fulfilled reservation.
    expect(markFulfilled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        customerEmailDeliveryId: "recovered-delivery",
      })
    );
  });

  test("skips awaiting_delivery paid orders even when updatedAt is stale", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "awaiting_delivery",
      updatedAt: Temporal.Now.instant().subtract({
        milliseconds: PAID_FULFILLMENT_PROCESSING_RETRY_AFTER_MS + 1000,
      }),
    });
    const claimPaidFulfillment = mock(() =>
      Effect.die("awaiting_delivery reservations must not be claimed")
    );
    const sendPaidReservationEmails = mock(() =>
      Effect.die("awaiting_delivery reservations must not send emails")
    );
    const markFulfillmentFailed = mock(() => Effect.void);

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
                claimPaidFulfillment,
                markFulfilled: mock(() => Effect.void),
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() =>
                  Effect.die("email flow should not start")
                ),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails,
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock(() =>
                  Effect.die("access flow should not start")
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("invoice processing should not start")
                ),
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    expect(result._tag).toBe("Success");
    expect(claimPaidFulfillment).not.toHaveBeenCalled();
    expect(sendPaidReservationEmails).not.toHaveBeenCalled();
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
  });

  test("retries invoice processing without reverting completed access fulfillment", async () => {
    const invoiceFailure = fulfillmentQueryFailure(
      "select invoices",
      "synthetic invoice failure"
    );
    const processInvoice = mock(() => Effect.fail(invoiceFailure));
    const markFulfillmentFailed = mock(() => Effect.void);
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "fulfilled",
    });

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
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {}),
              Layer.mock(WorkspaceReservationEmailService, {}),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {}),
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

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WorkspacePaidFulfillmentError",
        failureCode: "invoice_processing_failed",
        cause: invoiceFailure,
      },
    });
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
  });

  test("releases the fulfillment claim after an unexpected infrastructure failure", async () => {
    const order = fulfillmentOrderFixture({
      paymentState: "paid",
      fulfillmentState: "not_started",
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "held",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      activeCustomerEmailDeliveryLocale: null,
      locale: "en-US",
    });
    const connectionFailure = fulfillmentQueryFailure(
      "update reservations",
      "database connection unavailable"
    );
    const markFulfillmentFailed = mock(() => Effect.void);

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
                markReservationConfirmed: mock(() =>
                  Effect.fail(connectionFailure)
                ),
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
                markFulfilled: mock(() => Effect.void),
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {
                confirmReservation: mock(confirmDotyposReservationFixture),
              }),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() =>
                  Effect.die("email flow should not start")
                ),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails: mock(() =>
                  Effect.die("email flow should not start")
                ),
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock(() =>
                  Effect.die("access flow should not start")
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("invoice processing should not start")
                ),
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "WorkspacePaidFulfillmentError",
        failureCode: "fulfillment_completion_failed",
        cause: connectionFailure,
      });
    }
    expect(markFulfillmentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        failureCode: "fulfillment_completion_failed",
      })
    );
  });

  test("sends the retained winner locale when a stale writer loses the retain race", async () => {
    const order = fulfillmentOrderFixture({
      activePaymentAttemptId: paymentAttemptIdSchema.make("payment-attempt-id"),
      paymentState: "paid",
      fulfillmentState: "failed",
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
    // The stale writer resolves the changed preference, but the repository
    // reports the locale the winning concurrent worker already retained for
    // this idempotency generation.
    const retainActiveCustomerEmailDeliveryLocale = mock(
      (
        input: Parameters<
          IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
        >[0]
      ) => {
        expect(input.locale).toBe("cs-CZ");
        return Effect.succeed("en-US" as const);
      }
    );
    const sendInputs: unknown[] = [];
    const sendPaidReservationEmails = mock(
      (
        input: Parameters<
          IWorkspaceReservationEmailService["sendPaidReservationEmails"]
        >[0]
      ) => {
        sendInputs.push(input);
        return Effect.succeed(
          EmailDeliveryIdSchema.make("accepted-customer-email")
        );
      }
    );

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const service = yield* ReservationFulfillment;
          yield* service.run(fulfillmentReservationId);
        }),
        ReservationFulfillment.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              noReservationAuthors,
              Layer.mock(WorkspaceReservationRepository, {
                findById: mock(() => Effect.succeed(order)),
              }),
              Layer.mock(FulfillmentLedger, {
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                retainActiveCustomerEmailDeliveryLocale,
                markFulfilled: mock(() => Effect.void),
                markFulfillmentFailed: mock(() => Effect.void),
              }),
              Layer.mock(DotyposService, {}),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "account", locale: "cs-CZ" } as const)
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
                issueAfterFulfillment: mock(() => Effect.void),
              })
            )
          )
        )
      )
    );

    // The stale writer must send the authoritative retained locale, so the
    // content under the generation's idempotency key stays consistent.
    expect(sendInputs).toHaveLength(1);
    expect(sendInputs[0]).toMatchObject({ customerEmailLocale: "en-US" });
  });

  test("fails without sending when the claimed locale generation closed before retention", async () => {
    const priorDeliveryId = EmailDeliveryIdSchema.make(
      "recorded-prior-customer-email-delivery"
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
    const retainInputs: Parameters<
      IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
    >[0][] = [];
    // Another writer recorded this generation's accepted send between the
    // claim and the retention, so the repository reports the slot as closed.
    const retainActiveCustomerEmailDeliveryLocale = mock(
      (
        input: Parameters<
          IFulfillmentLedger["retainActiveCustomerEmailDeliveryLocale"]
        >[0]
      ) => {
        retainInputs.push(input);
        return Effect.succeed(null);
      }
    );
    const sendPaidReservationEmails = mock(() =>
      Effect.die("a closed generation must not send email")
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
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                retainActiveCustomerEmailDeliveryLocale,
                markFulfilled: mock(() =>
                  Effect.die("a closed generation must not fulfill")
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
                  Effect.die("invoice processing should not start")
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
        failureCode: "fulfillment_email_failed",
      },
    });
    // Retention is bound to the claimed delivery generation, not just the
    // reservation row.
    expect(retainInputs).toEqual([
      {
        id: fulfillmentReservationId,
        locale: "en-US",
        expectedActiveCustomerEmailDeliveryId: priorDeliveryId,
      },
    ]);
    expect(sendPaidReservationEmails).not.toHaveBeenCalled();
    // The closed-generation failure carries no fulfillment marker: the row is
    // owned by whichever writer closed the generation, so this writer must not
    // mark it failed.
    expect(markFulfillmentFailed).not.toHaveBeenCalled();
  });

  test("records a Dotypos reservation read failure without an email failure code", async () => {
    const order = fulfillmentOrderFixture({
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
    });
    const markFulfillmentFailed = mock(() => Effect.void);

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
                markReservationConfirmed: mock(() =>
                  Effect.die("confirmed reservations are not reconfirmed")
                ),
              }),
              Layer.mock(FulfillmentLedger, {
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                markFulfilled: mock(() =>
                  Effect.die("failed fulfillment must not complete")
                ),
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {
                confirmReservation: mock(() =>
                  Effect.die("confirmed reservations are not reconfirmed")
                ),
              }),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() =>
                  Effect.fail(
                    new WorkspaceReservationDetailsError({
                      reservationId: fulfillmentReservationId,
                      message: "Dotypos read timed out",
                      errorCode: "dotypos_reservation_load_failed",
                    })
                  )
                ),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails: mock(() =>
                  Effect.die("email flow should not start")
                ),
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock(() =>
                  Effect.die("access flow should not start")
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("invoice processing should not start")
                ),
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    // Only a real email failure may later be repaired by a delivered
    // webhook, so a provider read failure must not reuse that code.
    expect(result._tag).toBe("Failure");
    expect(markFulfillmentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        failureCode: "dotypos_reservation_failed",
      })
    );
  });

  test("does not confirm or deliver a paid order whose Dotypos hold was cancelled", async () => {
    const order = fulfillmentOrderFixture({
      paymentState: "paid",
      fulfillmentState: "not_started",
    });
    const claimed = fulfillmentOrderFixture({
      ...order,
      reservationState: "held",
      fulfillmentState: "processing",
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
    });
    const cancelled = new DotyposReservationCancelledError({
      reservationId: DotyposReservationIdSchema.make("dotypos-reservation-id"),
      message: "Dotypos reservation is already cancelled.",
    });
    const markReservationConfirmed = mock(() => Effect.void);
    const markFulfillmentFailed = mock(() => Effect.void);

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
                markReservationConfirmed,
              }),
              Layer.mock(FulfillmentLedger, {
                claimPaidFulfillment: mock(() => Effect.succeed(claimed)),
                markFulfilled: mock(() =>
                  Effect.die("a cancelled hold must not be fulfilled")
                ),
                markFulfillmentFailed,
              }),
              Layer.mock(DotyposService, {
                confirmReservation: mock(() => Effect.fail(cancelled)),
              }),
              Layer.mock(CustomerEmailLocaleService, {
                byDotyposCustomer: mock(() =>
                  Effect.succeed({ kind: "guest" } as const)
                ),
              }),
              Layer.mock(WorkspaceReservationService, {
                getReservation: mock(() =>
                  Effect.die("email flow should not start")
                ),
              }),
              Layer.mock(WorkspaceReservationEmailService, {
                sendPaidReservationEmails: mock(() =>
                  Effect.die("email flow should not start")
                ),
              }),
              Layer.mock(WorkspaceCheckoutAccessCodeService, {
                resolveCustomerAccessCode: mock(() =>
                  Effect.die("access flow should not start")
                ),
              }),
              recordCheckoutAnalytics().layer,
              Layer.mock(ReservationInvoiceService, {
                issueAfterFulfillment: mock(() =>
                  Effect.die("invoice processing should not start")
                ),
              })
            )
          )
        )
      ),
      Effect.runPromise
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "WorkspacePaidFulfillmentError",
        failureCode: "dotypos_reservation_unfulfillable",
      });
    }
    expect(markReservationConfirmed).not.toHaveBeenCalled();
    expect(markFulfillmentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "reservation-id",
        failureCode: "dotypos_reservation_unfulfillable",
      })
    );
  });
});
