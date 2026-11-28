import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import {
  DotyposReservationIdSchema,
  DotyposService,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { EmailServiceError } from "@deskohub/email/backend/service";
import { testEmailAddress } from "@deskohub/test-email";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Effect, Layer, Schema } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { WorkspaceReservation } from "@/features/reservation/backend/workspace-reservation.repository";
import {
  type WorkspaceReservationDetails,
  WorkspaceReservationDetailsError,
} from "@/features/reservation/backend/workspace-reservation.service";
import {
  workspaceReservationDetailsFixture,
  workspaceReservationFixture,
} from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";

const testActor = {
  source: "admin-ui",
  administrator: {
    accountId: customerAccountIdSchema.make("account-test"),
    email: testEmailAddress("reservation-admin"),
  },
} as const;

const queryError = (message: string) =>
  new EffectDrizzleQueryError({
    query: "select",
    params: [],
    cause: new Error(message),
  });

const detailsError = (message: string) =>
  new WorkspaceReservationDetailsError({
    reservationId: workspaceReservationIdSchema.make("reservation-refusal"),
    errorCode: "dotypos_reservation_load_failed",
    message,
  });

const dotyposError = (
  operation: DotyposUnavailable["operation"] = "cancelReservation"
) => new DotyposUnavailable({ operation, reason: "server" });

const emailError = (message: string) =>
  new EmailServiceError(message, undefined, undefined, {
    failureKind: "provider",
  });

/** The invoice side of a cancellation for reservations without an invoice. */
const invoiceCancellationFakes = async () => {
  const { InvoiceCancellationService } = await import(
    "@/features/accounting/backend/invoice-cancellation.service"
  );
  const { ReservationInvoiceService } = await import(
    "@/features/accounting/backend/reservation-invoice.service"
  );
  const { PaidFulfillmentQueueService } = await import(
    "@/features/checkout/backend/fulfillment/paid-fulfillment-queue.service"
  );
  return Layer.mergeAll(
    (await makeRecordingWorkspaceDatabase()).layer,
    Layer.mock(InvoiceCancellationService, {
      planForReservation: () => Effect.succeed(null),
      recordForReservation: () => Effect.succeed(null),
    }),
    // What only a restore's replacement invoice uses.
    Layer.mock(ReservationInvoiceService, {}),
    Layer.mock(PaidFulfillmentQueueService, {})
  );
};

test("operator cancellation cancels Dotypos, records the result, and optionally emails", async () => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationService } = await import(
    "./reservation-administration.service"
  );
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = Schema.decodeUnknownSync(workspaceReservationIdSchema)(
    "reservation-test"
  );
  const current = workspaceReservationFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make("dotypos-test"),
    fulfillmentState: "fulfilled",
    reservationState: "confirmed",
    updatedAt: Temporal.Now.instant(),
  });
  const details = workspaceReservationDetailsFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make("dotypos-test"),
    providerStatus: "CONFIRMED",
  });
  const cancelReservation = mock(() => Effect.void);
  const claimAdministrationCancellation = mock(() => Effect.succeed(current));
  const markAdministrationCancelled = mock(
    (_input: { readonly cancelledAt: Temporal.Instant }) => Effect.void
  );
  const sendCancellationEmail = mock(() => Effect.void);
  const recordCancellationEmailSent = mock(() => Effect.succeed(true));

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      reservationId: id,
      sendCancellationEmail: true,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, { cancelReservation }),
            Layer.mock(WorkspaceReservationEmailService, {
              sendCancellationEmail,
            }),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation,
              findById: () => Effect.succeed(current),
              markAdministrationCancellationFailed: () => Effect.void,
              markAdministrationCancelled,
              recordCancellationEmailSent,
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: () => Effect.succeed(details),
            })
          )
        )
      )
    ),
    Effect.runPromise
  );

  expect(result).toEqual({
    outcome: "cancelled",
    email: "sent",
    invoice: null,
  });
  expect(cancelReservation).toHaveBeenCalledWith("dotypos-test");
  expect(markAdministrationCancelled).toHaveBeenCalledWith({
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id,
    cancelledAt: expect.any(Temporal.Instant),
    claimedAt: current.updatedAt,
    failureCode: null,
  });
  expect(claimAdministrationCancellation).toHaveBeenCalledWith({
    expectedDotyposReservationId: details.dotyposReservationId,
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id,
    staleCancellingBefore: expect.any(Temporal.Instant),
  });
  expect(sendCancellationEmail).toHaveBeenCalledWith({ reservation: details });
  expect(recordCancellationEmailSent).toHaveBeenCalledWith({
    id,
    cancelledAt: markAdministrationCancelled.mock.calls[0]?.[0].cancelledAt,
    sentAt: expect.any(Temporal.Instant),
  });
});

/** Cancels a confirmed reservation, recording in order when its cancellation email went out and when it was stamped as sent. */
const cancelAndEmail = async ({
  send,
  sendCancellationEmail = () => Effect.void,
  recordCancellationEmailSent = () => Effect.succeed(true),
}: {
  readonly send: boolean;
  readonly sendCancellationEmail?: () => Effect.Effect<void, EmailServiceError>;
  readonly recordCancellationEmailSent?: () => Effect.Effect<
    boolean,
    EffectDrizzleQueryError
  >;
}) => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationService } = await import(
    "./reservation-administration.service"
  );
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = workspaceReservationIdSchema.make("reservation-email-stamp");
  const current = workspaceReservationFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-email-stamp"
    ),
    fulfillmentState: "fulfilled",
    reservationState: "confirmed",
    updatedAt: Temporal.Now.instant(),
  });
  const order: ("sent" | "stamped")[] = [];
  const stamp = mock(() =>
    Effect.sync(() => order.push("stamped")).pipe(
      Effect.andThen(recordCancellationEmailSent)
    )
  );
  const sendAndRecord = () =>
    sendCancellationEmail().pipe(
      Effect.tap(() => Effect.sync(() => order.push("sent")))
    );

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      reservationId: id,
      sendCancellationEmail: send,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, {
              cancelReservation: () => Effect.void,
            }),
            Layer.mock(WorkspaceReservationEmailService, {
              sendCancellationEmail: sendAndRecord,
            }),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation: () => Effect.succeed(current),
              findById: () => Effect.succeed(current),
              markAdministrationCancellationFailed: () => Effect.void,
              markAdministrationCancelled: () => Effect.void,
              recordCancellationEmailSent: stamp,
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: () =>
                Effect.succeed(
                  workspaceReservationDetailsFixture({
                    id,
                    providerStatus: "CONFIRMED",
                  })
                ),
            })
          )
        )
      )
    ),
    Effect.runPromise
  );
  return { email: result.email, order };
};

test("stamps the cancellation email only after it was sent, and a failed stamp keeps it sent", async () => {
  expect(
    await Promise.all([
      cancelAndEmail({ send: true }),
      cancelAndEmail({
        send: true,
        recordCancellationEmailSent: () => Effect.succeed(false),
      }),
      cancelAndEmail({
        send: true,
        recordCancellationEmailSent: () =>
          Effect.fail(queryError("database down")),
      }),
      cancelAndEmail({
        send: true,
        sendCancellationEmail: () => Effect.fail(emailError("Resend down")),
      }),
      cancelAndEmail({ send: false }),
    ])
  ).toEqual([
    { email: "sent", order: ["sent", "stamped"] },
    { email: "sent", order: ["sent", "stamped"] },
    { email: "sent", order: ["sent", "stamped"] },
    { email: "failed", order: [] },
    { email: "not_requested", order: [] },
  ]);
});

test("forced operator cancellation terminalizes a pending payment before cancelling", async () => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationService } = await import(
    "./reservation-administration.service"
  );
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = workspaceReservationIdSchema.make("reservation-pending");
  const activePaymentAttemptId = paymentAttemptIdSchema.make("payment-pending");
  const current = workspaceReservationFixture({
    id,
    activePaymentAttemptId,
    dotyposReservationId: DotyposReservationIdSchema.make("dotypos-pending"),
    fulfillmentState: "not_started",
    paymentState: "pending",
    reservationState: "held",
    updatedAt: Temporal.Now.instant(),
  });
  const details = workspaceReservationDetailsFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make("dotypos-pending"),
    providerStatus: "NEW",
  });
  const cancelReservation = mock(() => Effect.void);
  const markAdministrationCancelled = mock(() => Effect.void);
  const claimAdministrationCancellation = mock(() => Effect.succeed(current));

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      force: true,
      reservationId: id,
      sendCancellationEmail: false,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, { cancelReservation }),
            Layer.mock(WorkspaceReservationEmailService, {}),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation,
              findById: () => Effect.succeed(current),
              markAdministrationCancellationFailed: () => Effect.void,
              markAdministrationCancelled,
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: () => Effect.succeed(details),
            })
          )
        )
      )
    ),
    Effect.runPromise
  );

  expect(result).toEqual({
    outcome: "cancelled",
    email: "not_requested",
    invoice: null,
  });
  expect(claimAdministrationCancellation).toHaveBeenCalledWith({
    expectedDotyposReservationId: details.dotyposReservationId,
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id,
    pendingPaymentCancellation: {
      paymentAttemptId: activePaymentAttemptId,
      failureCode: "admin_forced_payment_cancellation",
    },
    staleCancellingBefore: expect.any(Temporal.Instant),
  });
  expect(cancelReservation).toHaveBeenCalledWith("dotypos-pending");
  expect(markAdministrationCancelled).toHaveBeenCalledWith({
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id,
    cancelledAt: expect.any(Temporal.Instant),
    claimedAt: current.updatedAt,
    failureCode: "admin_forced_payment_cancellation",
  });
});

test("retrying an already-cancelled reservation does not email again", async () => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationService } = await import(
    "./reservation-administration.service"
  );
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = Schema.decodeUnknownSync(workspaceReservationIdSchema)(
    "reservation-cancelled"
  );
  const sendCancellationEmail = mock(() => Effect.void);

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      reservationId: id,
      sendCancellationEmail: true,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, {}),
            Layer.mock(WorkspaceReservationEmailService, {
              sendCancellationEmail,
            }),
            Layer.mock(WorkspaceReservationRepository, {
              findById: () =>
                Effect.succeed(
                  workspaceReservationFixture({
                    id,
                    reservationState: "cancelled",
                  })
                ),
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: () => Effect.die("details must not be loaded"),
            })
          )
        )
      )
    ),
    Effect.runPromise
  );

  expect(result).toEqual({
    outcome: "already_cancelled",
    email: "not_requested",
    invoice: null,
  });
  expect(sendCancellationEmail).not.toHaveBeenCalled();
});

test("refuses cancellation while the confirmation email is still delivering", async () => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationError, ReservationAdministrationService } =
    await import("./reservation-administration.service");
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = Schema.decodeUnknownSync(workspaceReservationIdSchema)(
    "reservation-awaiting-delivery"
  );
  const cancelReservation = mock(() =>
    Effect.die("awaiting delivery must not cancel at the provider")
  );
  const claimAdministrationCancellation = mock(() =>
    Effect.die("awaiting delivery must not claim cancellation")
  );

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      reservationId: id,
      sendCancellationEmail: true,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, { cancelReservation }),
            Layer.mock(WorkspaceReservationEmailService, {}),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation,
              findById: () =>
                Effect.succeed(
                  workspaceReservationFixture({
                    id,
                    dotyposReservationId: DotyposReservationIdSchema.make(
                      "dotypos-awaiting-delivery"
                    ),
                    fulfillmentState: "awaiting_delivery",
                    paymentState: "paid",
                    reservationState: "confirmed",
                    updatedAt: Temporal.Now.instant(),
                  })
                ),
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: () => Effect.die("details must not be loaded"),
            })
          )
        )
      )
    ),
    Effect.flip,
    Effect.runPromise
  );

  expect(result).toBeInstanceOf(ReservationAdministrationError);
  expect(result).toMatchObject({
    code: "not_cancellable",
    reason: "delivery_in_progress",
    message:
      "The confirmation email is still being delivered. Try again after delivery completes.",
  });
  expect(cancelReservation).not.toHaveBeenCalled();
  expect(claimAdministrationCancellation).not.toHaveBeenCalled();
});

test("does not adopt a pre-existing provider cancellation", async () => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationError, ReservationAdministrationService } =
    await import("./reservation-administration.service");
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = Schema.decodeUnknownSync(workspaceReservationIdSchema)(
    "reservation-provider-cancelled"
  );
  const claimAdministrationCancellation = mock(() =>
    Effect.die("must not claim")
  );

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      reservationId: id,
      sendCancellationEmail: true,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, {}),
            Layer.mock(WorkspaceReservationEmailService, {}),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation,
              findById: () =>
                Effect.succeed(
                  workspaceReservationFixture({
                    id,
                    dotyposReservationId: DotyposReservationIdSchema.make(
                      "dotypos-provider-cancelled"
                    ),
                    fulfillmentState: "fulfilled",
                    paymentState: "paid",
                    reservationState: "confirmed",
                    updatedAt: Temporal.Now.instant(),
                  })
                ),
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: () =>
                Effect.succeed(
                  workspaceReservationDetailsFixture({
                    id,
                    dotyposReservationId: DotyposReservationIdSchema.make(
                      "dotypos-provider-cancelled"
                    ),
                    providerStatus: "CANCELLED",
                  })
                ),
            })
          )
        )
      )
    ),
    Effect.flip,
    Effect.runPromise
  );

  expect(result).toBeInstanceOf(ReservationAdministrationError);
  expect(result).toMatchObject({
    code: "not_cancellable",
    reason: "cancelled_in_dotypos",
  });
  expect(claimAdministrationCancellation).not.toHaveBeenCalled();
});

test("resumes a stale cancellation after an interrupted request", async () => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationService } = await import(
    "./reservation-administration.service"
  );
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = Schema.decodeUnknownSync(workspaceReservationIdSchema)(
    "reservation-interrupted"
  );
  const current = workspaceReservationFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-interrupted"
    ),
    fulfillmentState: "fulfilled",
    reservationState: "cancelling",
    updatedAt: Temporal.Now.instant().subtract({ minutes: 2 }),
  });
  const details = workspaceReservationDetailsFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-interrupted"
    ),
    providerStatus: "CANCELLED",
  });
  const claimAdministrationCancellation = mock(() => Effect.succeed(current));
  const markAdministrationCancelled = mock(() => Effect.void);

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      reservationId: id,
      sendCancellationEmail: false,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, {
              cancelReservation: () => Effect.die("already cancelled"),
            }),
            Layer.mock(WorkspaceReservationEmailService, {}),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation,
              findById: () => Effect.succeed(current),
              markAdministrationCancellationFailed: () => Effect.void,
              markAdministrationCancelled,
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation: () => Effect.succeed(details),
            })
          )
        )
      )
    ),
    Effect.runPromise
  );

  expect(result).toEqual({
    outcome: "cancelled",
    email: "not_requested",
    invoice: null,
  });
  expect(claimAdministrationCancellation).toHaveBeenCalledWith({
    expectedDotyposReservationId: details.dotyposReservationId,
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id,
    staleCancellingBefore: expect.any(Temporal.Instant),
  });
  expect(markAdministrationCancelled).toHaveBeenCalledWith({
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id,
    cancelledAt: expect.any(Temporal.Instant),
    claimedAt: current.updatedAt,
    failureCode: null,
  });
});

test("reconciles a duplicate provider failure after another worker cancelled", async () => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationService } = await import(
    "./reservation-administration.service"
  );
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  const id = Schema.decodeUnknownSync(workspaceReservationIdSchema)(
    "reservation-provider-race"
  );
  const current = workspaceReservationFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-provider-race"
    ),
    fulfillmentState: "fulfilled",
    paymentState: "paid",
    reservationState: "cancelling",
    updatedAt: Temporal.Now.instant().subtract({ minutes: 2 }),
  });
  const confirmed = workspaceReservationDetailsFixture({
    id,
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-provider-race"
    ),
    providerStatus: "CONFIRMED",
  });
  const cancelled = workspaceReservationDetailsFixture({
    ...confirmed,
    providerStatus: "CANCELLED",
  });
  const getReservation = mock(() =>
    Effect.succeed(
      getReservation.mock.calls.length === 1 ? confirmed : cancelled
    )
  );
  const markAdministrationCancellationFailed = mock(() => Effect.void);
  const markAdministrationCancelled = mock(() => Effect.void);

  const result = await Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      reservationId: id,
      sendCancellationEmail: false,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, {
              cancelReservation: () => Effect.fail(dotyposError()),
            }),
            Layer.mock(WorkspaceReservationEmailService, {}),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation: () => Effect.succeed(current),
              findById: () => Effect.succeed(current),
              markAdministrationCancellationFailed,
              markAdministrationCancelled,
            }),
            Layer.mock(WorkspaceReservationService, { getReservation })
          )
        )
      )
    ),
    Effect.runPromise
  );

  expect(result).toEqual({
    outcome: "cancelled",
    email: "not_requested",
    invoice: null,
  });
  expect(getReservation).toHaveBeenCalledTimes(2);
  expect(markAdministrationCancellationFailed).not.toHaveBeenCalled();
  expect(markAdministrationCancelled).toHaveBeenCalledTimes(1);
});

const cancelWith = async ({
  current,
  details = { providerStatus: "CONFIRMED" },
  findById = () => Effect.succeed(current),
  getReservation = () =>
    Effect.succeed(
      workspaceReservationDetailsFixture({
        id: workspaceReservationIdSchema.make("reservation-refusal"),
        dotyposReservationId:
          DotyposReservationIdSchema.make("dotypos-refusal"),
        ...details,
      })
    ),
  claimAdministrationCancellation = () => Effect.succeed(current),
  cancelReservation = () => Effect.void,
  markAdministrationCancelled = () => Effect.void,
  markAdministrationCancellationFailed = () => Effect.void,
  force,
}: {
  readonly current: WorkspaceReservation | null;
  readonly details?: Partial<WorkspaceReservationDetails>;
  readonly findById?: () => Effect.Effect<
    WorkspaceReservation | null,
    EffectDrizzleQueryError
  >;
  readonly getReservation?: () => Effect.Effect<
    WorkspaceReservationDetails,
    WorkspaceReservationDetailsError
  >;
  readonly claimAdministrationCancellation?: () => Effect.Effect<
    WorkspaceReservation | null,
    EffectDrizzleQueryError
  >;
  readonly cancelReservation?: () => Effect.Effect<void, DotyposUnavailable>;
  readonly markAdministrationCancelled?: () => Effect.Effect<
    void,
    EffectDrizzleQueryError
  >;
  readonly markAdministrationCancellationFailed?: () => Effect.Effect<
    void,
    EffectDrizzleQueryError
  >;
  readonly force?: boolean;
}) => {
  const { WorkspaceReservationEmailService } = await import(
    "@/features/checkout/backend/fulfillment/workspace-reservation-email.service"
  );
  const { WorkspaceReservationRepository } = await import(
    "@/features/reservation/backend/workspace-reservation.repository"
  );
  const { WorkspaceReservationService } = await import(
    "@/features/reservation/backend/workspace-reservation.service"
  );
  const { ReservationAdministrationService } = await import(
    "./reservation-administration.service"
  );
  const { ReservationRestorationService } = await import(
    "./reservation-restoration.service"
  );
  return Effect.gen(function* () {
    const service = yield* ReservationAdministrationService;
    return yield* service.cancel({
      actor: testActor,
      ...(force !== undefined && { force }),
      reservationId: workspaceReservationIdSchema.make("reservation-refusal"),
      sendCancellationEmail: false,
    });
  }).pipe(
    Effect.provide(
      ReservationAdministrationService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            await invoiceCancellationFakes(),
            Layer.mock(ReservationRestorationService, {}),
            Layer.mock(DotyposService, { cancelReservation }),
            Layer.mock(WorkspaceReservationEmailService, {}),
            Layer.mock(WorkspaceReservationRepository, {
              claimAdministrationCancellation,
              findById,
              markAdministrationCancellationFailed,
              markAdministrationCancelled,
            }),
            Layer.mock(WorkspaceReservationService, {
              getReservation,
            })
          )
        )
      )
    ),
    Effect.flip,
    Effect.runPromise
  );
};

const cancellableReservation: WorkspaceReservation =
  workspaceReservationFixture({
    id: workspaceReservationIdSchema.make("reservation-refusal"),
    dotyposReservationId: DotyposReservationIdSchema.make("dotypos-refusal"),
    fulfillmentState: "fulfilled",
    paymentState: "paid",
    reservationState: "confirmed",
    failureCode: null,
    activePaymentAttemptId: null,
    updatedAt: Temporal.Instant.from("2026-08-10T10:00:00Z"),
  });

test("explains each refusal before claiming the reservation", async () => {
  const claimAdministrationCancellation = mock(() => Effect.die("no claim"));
  const refusal = async (
    input: Omit<
      Parameters<typeof cancelWith>[0],
      "claimAdministrationCancellation"
    >
  ) => {
    const error = await cancelWith({
      ...input,
      claimAdministrationCancellation,
    });
    return { code: error.code, reason: error.reason };
  };

  expect(
    await Promise.all([
      refusal({ current: null }),
      refusal({
        current: null,
        findById: () => Effect.fail(queryError("database down")),
      }),
      refusal({
        current: { ...cancellableReservation, fulfillmentState: "processing" },
      }),
      refusal({
        current: { ...cancellableReservation, reservationState: "draft" },
      }),
      refusal({
        current: cancellableReservation,
        getReservation: () => Effect.fail(detailsError("Dotypos down")),
      }),
      refusal({
        current: { ...cancellableReservation, paymentState: "pending" },
        force: true,
      }),
    ])
  ).toEqual([
    { code: "not_found", reason: "not_found" },
    { code: "cancellation_failed", reason: "reservation_unavailable" },
    { code: "not_cancellable", reason: "confirmation_in_progress" },
    { code: "not_cancellable", reason: "invalid_state" },
    { code: "cancellation_failed", reason: "details_unavailable" },
    { code: "not_cancellable", reason: "pending_payment" },
  ]);
  expect(claimAdministrationCancellation).not.toHaveBeenCalled();
});

test("stops without cancelling in Dotypos when the claim fails or loses a race", async () => {
  const cancelReservation = mock(() => Effect.void);
  const lockTimeout = queryError("lock timeout");

  const failed = await cancelWith({
    current: cancellableReservation,
    claimAdministrationCancellation: () => Effect.fail(lockTimeout),
    cancelReservation,
  });
  const changed = await cancelWith({
    current: cancellableReservation,
    claimAdministrationCancellation: () => Effect.succeed(null),
    cancelReservation,
  });

  expect(failed).toMatchObject({
    code: "cancellation_failed",
    reason: "claim_failed",
    cause: lockTimeout,
  });
  expect(changed).toMatchObject({ code: "not_cancellable", reason: "changed" });
  expect(cancelReservation).not.toHaveBeenCalled();
});

test("marks the claim failed when Dotypos or the local record fails", async () => {
  const markAdministrationCancelled = mock(() => Effect.void);
  const markAdministrationCancellationFailed = mock(() => Effect.void);
  const dotyposRefused = dotyposError();
  const writeConflict = queryError("write conflict");

  const dotyposFailed = await cancelWith({
    current: cancellableReservation,
    cancelReservation: () => Effect.fail(dotyposRefused),
    getReservation: mock()
      .mockReturnValueOnce(
        Effect.succeed(
          workspaceReservationDetailsFixture({
            id: workspaceReservationIdSchema.make("reservation-refusal"),
            dotyposReservationId:
              DotyposReservationIdSchema.make("dotypos-refusal"),
            providerStatus: "CONFIRMED",
          })
        )
      )
      .mockReturnValueOnce(Effect.fail(detailsError("Dotypos down"))),
    markAdministrationCancelled,
    markAdministrationCancellationFailed,
  });
  expect(dotyposFailed).toMatchObject({
    code: "cancellation_failed",
    reason: "dotypos_failed",
    cause: dotyposRefused,
  });
  expect(markAdministrationCancelled).not.toHaveBeenCalled();
  expect(markAdministrationCancellationFailed).toHaveBeenLastCalledWith({
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id: cancellableReservation.id,
    claimedAt: cancellableReservation.updatedAt,
    failureCode: "admin_dotypos_cancel_failed",
    reason: "provider_cancellation_failed",
  });

  const recordFailed = await cancelWith({
    current: {
      ...cancellableReservation,
      failureCode: "admin_forced_payment_cancellation",
    },
    markAdministrationCancelled: () => Effect.fail(writeConflict),
    markAdministrationCancellationFailed,
  });
  expect(recordFailed).toMatchObject({
    code: "cancellation_failed",
    reason: "record_failed",
    cause: writeConflict,
  });
  expect(markAdministrationCancellationFailed).toHaveBeenLastCalledWith({
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id: cancellableReservation.id,
    claimedAt: cancellableReservation.updatedAt,
    failureCode: "admin_forced_payment_cancellation",
    reason: "local_cancellation_failed",
  });

  await cancelWith({
    current: cancellableReservation,
    markAdministrationCancelled: () => Effect.fail(writeConflict),
    markAdministrationCancellationFailed,
  });
  expect(markAdministrationCancellationFailed).toHaveBeenLastCalledWith({
    audit: expect.objectContaining({
      actorAccountId: testActor.administrator.accountId,
      source: testActor.source,
    }),
    id: cancellableReservation.id,
    claimedAt: cancellableReservation.updatedAt,
    failureCode: "admin_local_cancel_failed",
    reason: "local_cancellation_failed",
  });
});
