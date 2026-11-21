import { DotyposService } from "@deskohub/dotypos";
import { parsePhoneNumber } from "@deskohub/phone-number";
import { Context, Effect, Layer, Match, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CustomerAccountSections } from "@/features/account";
import {
  type AccountingDocumentSnapshot,
  makeAccountingDocumentSnapshot,
} from "@/features/accounting/accounting-document-snapshot";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { AccountingStorage } from "@/features/accounting/backend/accounting-storage";
import {
  type CheckoutSummary,
  type CheckoutSummaryChangedKeys,
  getCheckoutSummaryChangedKeys,
} from "@/features/checkout/checkout-summary";
import type { PaymentReturnTarget } from "@/features/checkout/payment-return-target";
import {
  isWorkspaceCoworkCurrentProductTier,
  type WorkspaceCoworkProductTier,
} from "@/features/checkout/product-catalog";
import { getCheckoutDetails } from "@/features/checkout/schemas/checkout-details";
import type { DiscountCommitment } from "@/features/discounts";
import { defaultPhoneRegion, type Locale } from "@/features/i18n";
import { isEarlyPerformanceRequestRequired } from "@/features/legal/early-performance";
import { getPaymentSubmitLegalEvidence } from "@/features/legal/payment-submit-evidence";
import {
  reservationLogFields,
  type WorkspaceReservation,
  WorkspaceReservationRepository,
} from "@/features/reservation/backend/workspace-reservation.repository";
import { getCoworkReservationIntervalInput } from "@/features/reservation/cowork-reservation";
import type { CoworkStay } from "@/features/reservation/cowork-stay";
import { hasOfficeReservationEnded } from "@/features/reservation/office-reservation";
import {
  getStoredWorkspaceReservationDetails,
  reservationOrderId,
  type WorkspaceReservationId,
} from "@/features/reservation/persistence-contracts";
import { hasReservationIntervalEnded } from "@/features/reservation/reservation-interval";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { type Money, moneyEquals } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  currentPreciseInstant,
  localDateTimeToInstant,
} from "@/shared/utils/temporal";
import { CheckoutAnalytics } from "../analytics/checkout-analytics.service";
import { FioPollWake } from "../fio/fio-poll-wake.service";
import { OrderPaymentHandlers } from "../payment/order-payment-handlers.service";
import { getPaymentCustomer } from "../payment/payment-customer";
import {
  type PaymentCustomer,
  PaymentProviders,
} from "../payment/payment-provider";
import { PaymentProvidersLive } from "../payment/payment-providers";
import { startPaymentSession } from "../payment/payment-session";
import { LegalEvidenceEventRepository } from "../repositories/legal-evidence-event.repository";
import {
  type PaymentAttempt,
  PaymentAttemptRepository,
  paymentAttemptLogFields,
} from "../repositories/payment-attempt.repository";
import { PaymentLifecycleRepository } from "../repositories/payment-lifecycle.repository";
import { QrPaymentRepository } from "../repositories/qr-payment.repository";
import { formatWorkspaceReservationNote } from "../reservation/dotypos-reservation.adapter";
import { CheckoutError } from "./checkout-error";
import {
  CheckoutPricingService,
  type PaymentPriceAffirmation,
} from "./checkout-pricing.service";
import { CheckoutUnavailableError } from "./checkout-unavailable";
import {
  type FreshPayState,
  PayState,
  type PayStateReissue,
  type PayStateTokenError,
  type PayStateWithHoldExpiry,
  type SignedPayState,
  toFreshPayState,
} from "./pay-state";
import { type OpenCheckout, PayableCheckout } from "./payable-checkout.service";
import { PaymentPageProviderStatus } from "./payment-page-provider-status";
import type { PriceVerdict } from "./price-verdict";
import { getReservationStatusPath } from "./reservation-status-url";
import {
  decidePaymentPageReopening,
  getPaymentPageToReopen,
  getReusableProviderRedirectUrl,
  isReusableAttemptState,
} from "./reusable-payment-attempt";

export { CheckoutError } from "./checkout-error";

type CheckoutRedirectResult = {
  readonly status: "redirect";
  readonly orderId: WorkspaceReservationId;
  readonly redirectUrl: string;
  readonly statusUrl?: string;
  /** The order is paid: completed internally or already paid before. */
  readonly paid?: true;
};

/**
 * Exclusive-end guard for cowork days, tier-aware via the reservation
 * domain's shared interval constructor: an Open Space day spans Prague-local
 * 00:00 until 17:00 exclusive on the reserved date, every other tier spans
 * Prague midnight to the next midnight (DST-correct calendar day). A new
 * payment attempt fails once the current instant is at or after the reserved
 * day's exclusive end — exactly at the end included, and always for dates
 * already before the current local date, whose exclusive end is past.
 */
const isCoworkReservationExclusiveEndReached = (input: {
  readonly entryTier: WorkspaceCoworkProductTier;
  readonly date: string;
  readonly stay?: CoworkStay;
  readonly now?: Temporal.Instant;
}) => {
  const now = input.now ?? Temporal.Now.instant();
  const exclusiveEnd = localDateTimeToInstant({
    dateTime: getCoworkReservationIntervalInput(
      input.entryTier,
      input.date,
      input.stay
    ).endsAt,
    timeZone: workspaceSiteConstants.location.timeZone,
  });

  return Temporal.Instant.compare(now, exclusiveEnd) >= 0;
};

const ensureReservationHasNotEnded = Effect.fn(
  "checkout.ensureReservationHasNotEnded"
)(function* (reservation: SignedPayState["reservation"]) {
  const error = Match.value(reservation).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: (coworkReservation) => {
        // Old tiers stay decodable for history but are no longer current:
        // in-flight legacy checkouts get no grace path and must restart with
        // the current offers instead of creating a payment attempt at old
        // amounts.
        if (!isWorkspaceCoworkCurrentProductTier(coworkReservation.entryTier)) {
          return new CheckoutError({
            code: "cowork_offer_replaced",
            message:
              "This cowork offer is no longer available. Please start a new reservation with the current offers.",
          });
        }
        // Exclusive-day end: a new payment attempt for an Open Space day
        // fails once the current Prague time is at or after 17:00 on the
        // reserved date, and a Reserved Desk day once it is at or after
        // midnight after the reserved date (noon the next day for an
        // overnight stay) — including reservations whose date is already
        // before the current local date. Idempotent
        // provider-session reuse above is not affected.
        if (isCoworkReservationExclusiveEndReached(coworkReservation)) {
          return new CheckoutError({
            code: "cowork_reservation_ended",
            message:
              coworkReservation.entryTier === "open-space"
                ? "Open Space reservation day has already ended."
                : "Reserved Desk reservation day has already ended.",
          });
        }
        return undefined;
      },
      "meeting-room": (meetingRoomReservation) => {
        if (!hasReservationIntervalEnded(meetingRoomReservation)) return;
        return new CheckoutError({
          code: "meeting_room_reservation_ended",
          message: "Meeting-room reservation has already ended.",
        });
      },
      office: (officeReservation) => {
        if (!hasOfficeReservationEnded(officeReservation)) return;
        return new CheckoutError({
          code: "office_reservation_ended",
          message: "Office reservation has already ended.",
        });
      },
    })
  );
  if (!error) return;

  yield* Effect.logInfo(
    "Hosted payment checkout rejected: reservation already ended"
  );
  return yield* error;
});

interface CheckoutSubmitInput {
  readonly payStateToken: string;
  readonly legalConsent?: boolean;
  readonly earlyPerformanceConsent?: boolean;
  /** The app the hosted payment returns to. Omit for the Workspace site. */
  readonly returnTarget?: PaymentReturnTarget;
}

interface PublicPaymentChoice {
  readonly method: "card" | "qr";
  readonly fio?: { readonly accountKey: string } | undefined;
}

type CheckoutResult =
  | CheckoutRedirectResult
  | ({
      readonly status: "pricing_changed";
      readonly changedKeys: ReturnType<typeof getCheckoutSummaryChangedKeys>;
      readonly freshSummary: CheckoutSummary;
    } & FreshPayState)
  | { readonly status: "in_progress" };

type PublicCheckoutResult =
  | CheckoutResult
  | {
      readonly status: "qr_pending";
      readonly orderId: WorkspaceReservationId;
      readonly variableSymbol: string;
      readonly accountKey: string;
      readonly amount: Money;
      readonly expiresAt: Temporal.Instant;
    };

export interface ICheckoutService {
  readonly createHostedPaymentCheckout: (
    input: CheckoutSubmitInput,
    locale: Locale
  ) => Effect.Effect<CheckoutResult, CheckoutError>;
  readonly startReservationPayment: (
    input: Omit<CheckoutSubmitInput, "returnTarget"> & PublicPaymentChoice,
    locale: Locale
  ) => Effect.Effect<PublicCheckoutResult, CheckoutError>;
  /** The caller authorizes the reservation author before invoking this operation. */
  readonly resumeReservationPayment: (
    input: PublicPaymentChoice & {
      readonly reservationId: WorkspaceReservationId;
      readonly fio: { readonly accountKey: string };
    },
    locale: Locale
  ) => Effect.Effect<PublicCheckoutResult, CheckoutError>;
}

export class CheckoutService extends Context.Service<
  CheckoutService,
  ICheckoutService
>()("CheckoutService") {
  static Default = makeCheckoutServiceLayer(this);

  static Live = this.Default.pipe(
    Layer.provide(CustomerAccountSections.Live),
    Layer.provide(PayableCheckout.Default),
    Layer.provide(LegalEvidenceEventRepository.Default),
    Layer.provide(CheckoutAnalytics.Live),
    Layer.provide(OrderPaymentHandlers.Live),
    Layer.provide(PaymentAttemptRepository.Default),
    Layer.provide(PaymentLifecycleRepository.Live),
    Layer.provide(QrPaymentRepository.Default),
    Layer.provide(AccountingStorage.Live),
    Layer.provide(FioPollWake.Live),
    Layer.provide(WorkspaceReservationRepository.Default),
    Layer.provide(WorkspaceDatabase.Default),
    Layer.provide(WorkspaceDotyposLayer),
    Layer.provide(PaymentPageProviderStatus.Default),
    Layer.provide(PaymentProvidersLive),
    Layer.provide(CheckoutPricingService.Live),
    Layer.provide(SealedStateKeys.Default)
  );
}

/** A Pay state that doesn't open for the submitting page's locale. */
const toInvalidPayStateError = (cause: PayStateTokenError) =>
  new CheckoutError({
    code: "checkout_failed",
    message: "Pay state is invalid or expired. Please review checkout again.",
    cause,
  });

const reissuePriceReviewPayState: (
  state: PayStateWithHoldExpiry,
  outcome: PayStateReissue
) => Effect.Effect<FreshPayState, CheckoutError, SealedStateKeys> = Effect.fn(
  "reissuePriceReviewPayState"
)((state, outcome) =>
  PayState.reissue(state, outcome).pipe(
    Effect.map(toFreshPayState),
    Effect.mapError(
      (cause) =>
        new CheckoutError({
          code: "checkout_failed",
          message: "A refreshed Pay state could not be created.",
          cause,
        })
    )
  )
);

const mapCheckoutFailure = <E>(cause: E | CheckoutError): CheckoutError =>
  cause instanceof CheckoutError
    ? cause
    : new CheckoutError({
        code: "checkout_failed",
        message:
          "Payment checkout could not be started. Please review your details and try again.",
        cause,
      });

const getCheckoutRedirectResult = (input: {
  readonly orderId: WorkspaceReservationId;
  readonly redirectUrl: string;
  readonly statusUrl?: string;
  readonly paid?: true;
}): CheckoutRedirectResult => ({ status: "redirect", ...input });

const getHostedPaymentCheckoutResult = (input: {
  readonly locale: Locale;
  readonly providerRedirectUrl: string;
  readonly workspaceReservationId: WorkspaceReservationId;
}): CheckoutRedirectResult =>
  getCheckoutRedirectResult({
    orderId: input.workspaceReservationId,
    redirectUrl: input.providerRedirectUrl,
    statusUrl: getReservationStatusPath({
      locale: input.locale,
      orderId: input.workspaceReservationId,
      setBypassCookie: true,
    }),
  });

function makeCheckoutServiceLayer(service: typeof CheckoutService) {
  return Layer.effect(
    service,
    Effect.gen(function* () {
      const dotypos = yield* DotyposService;
      const providers = yield* PaymentProviders;
      const reservations = yield* WorkspaceReservationRepository;
      const paymentAttempts = yield* PaymentAttemptRepository;
      const orderPaymentHandlers = yield* OrderPaymentHandlers;
      const legalEvidenceEvents = yield* LegalEvidenceEventRepository;
      const checkoutAnalytics = yield* CheckoutAnalytics;
      const pricing = yield* CheckoutPricingService;
      const payableCheckout = yield* PayableCheckout;
      const accountSections = yield* CustomerAccountSections;
      const lifecycle = Option.getOrUndefined(
        yield* Effect.serviceOption(PaymentLifecycleRepository)
      );
      const qrPayments = Option.getOrUndefined(
        yield* Effect.serviceOption(QrPaymentRepository)
      );
      const accountingSnapshots = Option.getOrUndefined(
        yield* Effect.serviceOption(AccountingDocumentSnapshots)
      );
      const fioWake = Option.getOrUndefined(
        yield* Effect.serviceOption(FioPollWake)
      );

      const providerPageStatus = Option.getOrUndefined(
        yield* Effect.serviceOption(PaymentPageProviderStatus)
      );
      const provideSealedStateKeys = Effect.provideService(
        SealedStateKeys,
        yield* SealedStateKeys
      );

      const providePaymentSession = Effect.provide(
        Context.make(PaymentProviders, providers).pipe(
          Context.add(OrderPaymentHandlers, orderPaymentHandlers),
          Context.add(CheckoutAnalytics, checkoutAnalytics)
        )
      );

      /** Payment starts only on an order still payable right before it. */
      const reconfirmPayableCheckout = Effect.fn(
        "checkout.reconfirmPayableCheckout"
      )(function* (checkout: OpenCheckout) {
        const current = yield* payableCheckout.reconfirm(checkout.state);
        yield* Effect.logDebug("Checkout payable reservation revalidated");
        return current;
      });

      const paymentInProgress = { status: "in_progress" } as const;
      const reopenPublicCard = Effect.fn("checkout.reopenPublicCard")(
        function* (input: {
          readonly attempt: PaymentAttempt;
          readonly reservation: WorkspaceReservation;
          readonly expiresAt: Temporal.Instant;
          readonly locale: Locale;
        }) {
          const { attempt, reservation, expiresAt, locale } = input;
          if (
            !providerPageStatus ||
            !qrPayments ||
            attempt.provider !== "nexi"
          ) {
            return paymentInProgress;
          }
          const page = getPaymentPageToReopen(
            attempt,
            yield* currentPreciseInstant,
            expiresAt
          );
          if ("closed" in page) return paymentInProgress;

          const observation = yield* providerPageStatus.observe({
            attempt,
            reservation,
          });
          if (observation === "activity" || observation === "inactive") {
            return paymentInProgress;
          }

          // A settlement or termination can commit while the provider is
          // answering. Confirm the hold and the same card attempt again.
          const latestReservation = yield* reservations.findById(
            reservation.id
          );
          if (
            latestReservation?.reservationState !== "held" ||
            latestReservation.paymentState !== "pending"
          )
            return paymentInProgress;
          const currentCard = yield* qrPayments.findCardAttempt(
            reservationOrderId(reservation.id)
          );
          if (!currentCard || currentCard.id !== attempt.id)
            return paymentInProgress;

          const now = yield* currentPreciseInstant;
          const currentPage = getPaymentPageToReopen(
            currentCard,
            now,
            expiresAt
          );
          if (
            "closed" in currentPage ||
            decidePaymentPageReopening(
              currentCard,
              now,
              observation,
              expiresAt
            ) !== "open"
          ) {
            return paymentInProgress;
          }
          return getHostedPaymentCheckoutResult({
            locale,
            providerRedirectUrl: currentPage.providerRedirectUrl,
            workspaceReservationId: reservation.id,
          });
        }
      );

      const startProviderSession = Effect.fn("checkout.startProviderSession")(
        function* (input: {
          readonly workspaceReservationId: WorkspaceReservationId;
          readonly correlationId: string;
          readonly locale: Locale;
          readonly total: Money;
          readonly commitment: DiscountCommitment;
          readonly customer: PaymentCustomer;
          readonly accountingSnapshot: AccountingDocumentSnapshot;
          readonly reservation: SignedPayState["reservation"];
          readonly returnTarget: PaymentReturnTarget | undefined;
          readonly checkout: OpenCheckout;
          readonly fio?: { readonly accountKey: string } | undefined;
        }) {
          yield* Effect.annotateLogsScoped({
            reservationId: input.workspaceReservationId,
            correlationId: input.correlationId,
            checkoutSessionId: input.checkout.state.checkoutSessionId,
            locale: input.locale,
            totalValue: input.total.value,
            totalCurrency: input.total.currency,
            hasCustomer: true,
          });
          yield* Effect.logInfo("Checkout provider session start requested");

          const { retriedAttempt } = yield* reconfirmPayableCheckout(
            input.checkout
          );

          const orderId = reservationOrderId(input.workspaceReservationId);
          const fio = input.fio;
          const session = yield* startPaymentSession({
            kind: input.checkout.kind,
            orderId,
            locale: input.locale,
            correlationId: input.correlationId,
            amount: input.total,
            customer: input.customer,
            retriedAttempt,
            beforeAttempt: Effect.gen(function* () {
              yield* ensureReservationHasNotEnded(input.reservation);
              yield* reservations.recordPaymentReturnTarget({
                id: input.workspaceReservationId,
                paymentReturnTarget: input.returnTarget,
              });
            }),
            ...(fio && lifecycle && !retriedAttempt
              ? {
                  admitProvider: ({
                    provider,
                    providerOrderId,
                  }: {
                    readonly provider: "nexi" | "mock";
                    readonly providerOrderId: string;
                  }) =>
                    lifecycle.createPendingProviderAttempt({
                      orderId,
                      amount: input.total,
                      locale: input.locale,
                      commitment: input.commitment,
                      accountingSnapshot: input.accountingSnapshot,
                      provider,
                      providerOrderId,
                      publicPayment: fio,
                    }),
                }
              : {
                  details: {
                    commitment: input.commitment,
                    accountingSnapshot: input.accountingSnapshot,
                  },
                }),
          }).pipe(providePaymentSession);
          const { attachedAttempt, hostedPaymentPage } = session;
          if ("reused" in session) {
            if (!fio || !qrPayments) return paymentInProgress;
            const window = yield* qrPayments.findPaymentWindow(orderId);
            if (window?.accountKey !== fio.accountKey) return paymentInProgress;
            return yield* reopenPublicCard({
              attempt: attachedAttempt,
              reservation: input.checkout.reservation,
              expiresAt: window.expiresAt,
              locale: input.locale,
            });
          }
          yield* checkoutAnalytics.paymentStarted({
            attempt: attachedAttempt,
            timestamp: attachedAttempt.updatedAt,
          });
          yield* Effect.logDebug(
            "Checkout hosted payment page attach completed"
          );
          yield* Effect.logInfo("Checkout provider session started");

          return getHostedPaymentCheckoutResult({
            locale: input.locale,
            providerRedirectUrl: hostedPaymentPage.hostedPage,
            workspaceReservationId: input.workspaceReservationId,
          });
        }
      );

      const completeInternalPayment = Effect.fn(
        "checkout.completeInternalPayment"
      )(function* (input: {
        readonly workspaceReservationId: WorkspaceReservationId;
        readonly locale: Locale;
        readonly total: Money;
        readonly commitment: DiscountCommitment;
        readonly accountingSnapshot: AccountingDocumentSnapshot;
        readonly reservation: SignedPayState["reservation"];
        readonly checkout: OpenCheckout;
      }) {
        yield* reconfirmPayableCheckout(input.checkout);

        yield* ensureReservationHasNotEnded(input.reservation);

        const handler = orderPaymentHandlers.byKind[input.checkout.kind];
        if (!handler) {
          return yield* new CheckoutError({
            code: "checkout_failed",
            message: "The order kind does not support payment.",
          });
        }
        const orderId = reservationOrderId(input.workspaceReservationId);
        const transition = yield* handler.admitInternal({
          orderId,
          amount: input.total,
          locale: input.locale,
          details: {
            commitment: input.commitment,
            accountingSnapshot: input.accountingSnapshot,
          },
        });

        if (transition.changed) {
          yield* checkoutAnalytics.paymentCompleted({
            attempt: transition.attempt,
            timestamp: transition.timestamp,
          });
        }

        yield* handler.fulfill(orderId).pipe(
          Effect.catch((cause) =>
            Effect.logError(
              "Internal payment completed but paid fulfillment failed",
              {
                orderId: input.workspaceReservationId,
                paymentAttemptId: transition.attempt.id,
                cause,
              }
            )
          )
        );

        return getCheckoutRedirectResult({
          orderId: input.workspaceReservationId,
          redirectUrl: getReservationStatusPath({
            locale: input.locale,
            orderId: input.workspaceReservationId,
            outcome: "success",
            setBypassCookie: true,
          }),
          paid: true,
        });
      });

      const getCompletedCheckoutResult = Effect.fn(
        "checkout.getCompletedCheckoutResult"
      )(function* (input: {
        readonly orderId: WorkspaceReservationId;
        readonly locale: Locale;
      }) {
        const handler = orderPaymentHandlers.byKind.reservation;
        if (!handler) {
          return yield* new CheckoutError({
            code: "checkout_failed",
            message: "The order kind does not support payment.",
          });
        }
        yield* handler.fulfill(reservationOrderId(input.orderId)).pipe(
          Effect.catch((cause) =>
            Effect.logError("Paid checkout fulfillment retry failed", {
              orderId: input.orderId,
              cause,
            })
          )
        );

        return getCheckoutRedirectResult({
          orderId: input.orderId,
          redirectUrl: getReservationStatusPath({
            locale: input.locale,
            orderId: input.orderId,
            outcome: "success",
            setBypassCookie: true,
          }),
          paid: true,
        });
      });

      /**
       * An order that can't be paid again is either already paid, which the
       * resubmitted Pay state recovers, or still moving.
       */
      const recoverUnpayableOrder = Effect.fnUntraced(function* (input: {
        readonly unavailable: CheckoutUnavailableError;
        readonly locale: Locale;
      }) {
        const { unavailable } = input;
        yield* Effect.logInfo(
          "Hosted payment checkout reservation is unavailable",
          { orderId: unavailable.orderId, reason: unavailable.reason }
        );
        if (unavailable.paidOrderId !== undefined) {
          yield* Effect.logInfo(
            "Hosted payment checkout recovered completed reservation"
          );
          return yield* getCompletedCheckoutResult({
            orderId: unavailable.paidOrderId,
            locale: input.locale,
          });
        }

        yield* Effect.logWarning(
          "Hosted payment checkout returned in_progress: reservation unavailable"
        );

        return { status: "in_progress" as const };
      });

      type ReservationProgressInput = {
        /**
         * The order as opened, or as read again under the account lock; the
         * progress checks read only its payment state and active attempt.
         */
        readonly reservation: WorkspaceReservation;
        readonly state: SignedPayState;
        readonly locale: Locale;
        readonly method?: PublicPaymentChoice["method"];
        readonly returnTarget: PaymentReturnTarget | undefined;
      };

      /**
       * The result a paid order or an existing provider session already
       * decides; `undefined` when a new payment may start.
       */
      const findReservationProgressResult = Effect.fnUntraced(function* (
        input: ReservationProgressInput
      ) {
        const paidResult = yield* findPaidOrderResult(input);
        if (paidResult) return paidResult;
        if (input.method === "qr" && input.reservation.activePaymentAttemptId) {
          return paymentInProgress;
        }
        // Shared-window attempts are only reopened through the method-aware
        // path, including when a stale Pay form omits the payment method.
        if (
          qrPayments &&
          (yield* qrPayments.findPaymentWindow(
            reservationOrderId(input.reservation.id)
          ))
        ) {
          return paymentInProgress;
        }
        return yield* findActiveAttemptResult(input);
      });

      const findPaidOrderResult = Effect.fnUntraced(function* ({
        reservation,
        locale,
      }: ReservationProgressInput) {
        if (reservation.paymentState === "paid") {
          yield* Effect.logInfo(
            "Hosted payment checkout reused completed reservation"
          );

          return yield* getCompletedCheckoutResult({
            orderId: reservation.id,
            locale,
          });
        }

        yield* Effect.annotateLogsScoped({
          correlationId: reservation.correlationId,
        });
        return undefined;
      });

      // An existing provider session can settle independently. Returning its
      // matching URL is idempotent recovery, not new payment initiation.
      const findActiveAttemptResult = Effect.fnUntraced(function* ({
        reservation,
        state,
        locale,
        returnTarget,
      }: ReservationProgressInput) {
        if (!reservation.activePaymentAttemptId) return undefined;

        yield* Effect.logDebug(
          "Hosted payment checkout active payment attempt lookup started"
        );
        const attempt = yield* paymentAttempts.findById(
          reservation.activePaymentAttemptId
        );
        yield* Effect.annotateLogsScoped(paymentAttemptLogFields(attempt));
        yield* Effect.logDebug(
          "Hosted payment checkout active payment attempt lookup completed"
        );
        if (!attempt || !isReusableAttemptState(attempt.state)) {
          return undefined;
        }

        if (
          attempt.provider === "internal" ||
          attempt.provider === "fio" ||
          !providers.activeProviders.includes(attempt.provider)
        ) {
          return { status: "in_progress" as const };
        }
        const providerRedirectUrl = getReusableProviderRedirectUrl(attempt);
        if (
          providerRedirectUrl &&
          moneyEquals(attempt.amount, state.acceptedTotal)
        ) {
          yield* Effect.logInfo(
            "Hosted payment checkout reused active provider session"
          );
          // The reused page returns where this submission's answer points.
          yield* reservations.recordPaymentReturnTarget({
            id: reservation.id,
            paymentReturnTarget: returnTarget,
          });
          return getHostedPaymentCheckoutResult({
            locale,
            providerRedirectUrl,
            workspaceReservationId: reservation.id,
          });
        }

        yield* Effect.logInfo(
          "Hosted payment checkout returned in_progress: active attempt is not reusable for signed summary"
        );

        return { status: "in_progress" as const };
      });

      /** A signed state still awaiting the customer's review of a price change. */
      const getPendingPricingReviewResult = Effect.fnUntraced(
        function* (input: {
          readonly checkout: OpenCheckout;
          readonly changedKeys: CheckoutSummaryChangedKeys;
        }) {
          const { state } = input.checkout;
          yield* Effect.logInfo(
            "Hosted payment checkout returned existing pricing_changed review"
          );

          const priceReviewPayState = yield* reissuePriceReviewPayState(state, {
            kind: "review_pending",
          }).pipe(provideSealedStateKeys);
          return {
            status: "pricing_changed" as const,
            changedKeys: input.changedKeys,
            freshSummary: PayState.summary(state),
            ...priceReviewPayState,
          };
        }
      );

      /** Re-prices the signed order for the reservation's stored customer. */
      const affirmSignedPricing = Effect.fnUntraced(function* (input: {
        readonly checkout: OpenCheckout;
        readonly locale: Locale;
      }) {
        const { locale } = input;
        const { state } = input.checkout;
        const { dotyposCustomerId } = input.checkout.reservation;
        const verdict = yield* pricing.affirmForPayment({
          ...state,
          bookedAt: PayState.bookedAt(state),
          dotyposCustomerId,
          locale,
        });
        yield* Effect.annotateLogsScoped({
          quoteFingerprint: verdict.priced.quote.fingerprint,
        });
        yield* Effect.logDebug("Hosted payment checkout quote built");
        yield* Effect.logDebug(
          "Hosted payment checkout quote comparison started"
        );
        return { dotyposCustomerId, verdict };
      });

      /**
       * A fresh Pay state to review when the payment verdict says the signed
       * price changed; `undefined` when it still holds.
       */
      const findRepricedResult = Effect.fnUntraced(function* (input: {
        readonly checkout: OpenCheckout;
        readonly verdict: PriceVerdict<PaymentPriceAffirmation>;
      }) {
        const { verdict } = input;
        const { state } = input.checkout;
        if (verdict.status === "affirmed") return undefined;
        const { changedKeys } = verdict;
        const prepared = verdict.priced;
        const freshSummary = prepared.summary;
        yield* Effect.annotateLogsScoped({
          changedSectionKeys: changedKeys.sectionKeys.join(","),
          changedItemKeys: changedKeys.itemKeys.join(","),
          acceptedQuoteFingerprint: state.quote.fingerprint,
          acceptedTotalValue: state.acceptedTotal.value,
          freshQuoteFingerprint: prepared.quote.fingerprint,
          freshTotalValue: freshSummary.total.value,
        });
        yield* Effect.logInfo(
          "Hosted payment checkout returned pricing_changed"
        );

        const priceReviewPayState = yield* reissuePriceReviewPayState(state, {
          kind: "repriced",
          verdict,
        }).pipe(provideSealedStateKeys);
        return {
          status: "pricing_changed" as const,
          changedKeys,
          freshSummary,
          ...priceReviewPayState,
        };
      });

      const readQrPayment = Effect.fnUntraced(function* (
        reservationId: WorkspaceReservationId
      ) {
        const attempt =
          qrPayments && (yield* qrPayments.findForReservation(reservationId));
        return attempt
          ? {
              status: "qr_pending" as const,
              orderId: reservationId,
              variableSymbol: attempt.variableSymbol,
              accountKey: attempt.accountKey,
              amount: attempt.amount,
              expiresAt: attempt.expiresAt,
            }
          : paymentInProgress;
      });

      const resumePublicPayment = Effect.fn(
        "checkout.resumeReservationPayment"
      )(
        function* (
          input: PublicPaymentChoice & {
            readonly reservationId: WorkspaceReservationId;
          },
          locale: Locale
        ) {
          if (!qrPayments || !lifecycle || !input.fio) return undefined;
          const orderId = reservationOrderId(input.reservationId);
          const window = yield* qrPayments.findPaymentWindow(orderId);
          if (!window) return undefined;
          if (yield* reservations.findEntryPackClaim(input.reservationId)) {
            return paymentInProgress;
          }
          if (
            window.accountKey !== input.fio.accountKey ||
            Temporal.Instant.compare(
              window.expiresAt,
              yield* currentPreciseInstant
            ) <= 0
          ) {
            return paymentInProgress;
          }

          const reservation = yield* reservations.findById(input.reservationId);
          if (
            !reservation ||
            reservation.agentClientId ||
            reservation.reservationState !== "held" ||
            reservation.paymentState !== "pending" ||
            !reservation.activePaymentAttemptId
          )
            return paymentInProgress;

          if (input.method === "card") {
            const card = yield* qrPayments.findCardAttempt(orderId);
            if (card) {
              return yield* reopenPublicCard({
                attempt: card,
                reservation,
                expiresAt: window.expiresAt,
                locale,
              });
            }
          } else {
            const existing = yield* readQrPayment(input.reservationId);
            if (existing.status === "qr_pending") return existing;
          }

          const accepted = yield* paymentAttempts.findById(
            reservation.activePaymentAttemptId
          );
          if (!accepted) return paymentInProgress;
          const publicPayment = {
            accountKey: window.accountKey,
            useAcceptedCommitment: true as const,
          };

          if (input.method === "qr") {
            if (!fioWake) return paymentInProgress;
            yield* lifecycle
              .createPendingQrAttempt({
                orderId,
                amount: accepted.amount,
                locale,
                publicPayment,
              })
              .pipe(Effect.provideService(FioPollWake, fioWake));
            return yield* readQrPayment(input.reservationId);
          }

          const snapshot =
            accountingSnapshots &&
            (yield* accountingSnapshots.find(accepted.id));
          if (!snapshot || !providers.activeProviders.includes("nexi"))
            return paymentInProgress;
          const customerDetails = {
            id: reservation.dotyposCustomerId,
            name: snapshot.buyer.legalName,
          };
          const customer: PaymentCustomer = snapshot.delivery
            ? { ...customerDetails, email: snapshot.delivery.email }
            : customerDetails;
          if ((yield* providers.selectForCustomer(customer)) !== "nexi")
            return paymentInProgress;
          const session = yield* startPaymentSession({
            kind: "reservation",
            orderId,
            locale: snapshot.locale,
            amount: accepted.amount,
            correlationId: reservation.correlationId,
            customer,
            beforeAttempt: Effect.void,
            admitProvider: ({ provider, providerOrderId }) =>
              lifecycle.createPendingProviderAttempt({
                orderId,
                amount: accepted.amount,
                locale: snapshot.locale,
                publicPayment,
                provider,
                providerOrderId,
              }),
          }).pipe(providePaymentSession);
          if ("reused" in session) {
            return yield* reopenPublicCard({
              attempt: session.attachedAttempt,
              reservation,
              expiresAt: window.expiresAt,
              locale,
            });
          }
          if (
            Temporal.Instant.compare(
              yield* currentPreciseInstant,
              window.expiresAt
            ) >= 0
          ) {
            return paymentInProgress;
          }
          return getHostedPaymentCheckoutResult({
            locale,
            providerRedirectUrl: session.hostedPaymentPage.hostedPage,
            workspaceReservationId: input.reservationId,
          });
        },
        (effect) =>
          effect.pipe(
            Effect.scoped,
            Effect.catchTag("PaymentLifecycleStateError", () =>
              Effect.succeed(paymentInProgress)
            ),
            Effect.mapError(mapCheckoutFailure)
          )
      );

      const submitCheckout = Effect.fn("checkout.createHostedPaymentCheckout")(
        function* (
          input: CheckoutSubmitInput & Partial<PublicPaymentChoice>,
          locale: Locale
        ) {
          yield* Effect.annotateLogsScoped({
            locale,
            hasPayStateToken: input.payStateToken.length > 0,
            legalConsent: input.legalConsent === true,
            earlyPerformanceConsent: input.earlyPerformanceConsent === true,
            returnTarget: input.returnTarget,
          });
          yield* Effect.logInfo("Hosted payment checkout creation started");

          if (input.legalConsent !== true) {
            yield* Effect.logInfo(
              "Hosted payment checkout rejected: missing legal consent"
            );

            return yield* new CheckoutError({
              code: "legal_consent_required",
              message: "Legal consent is required before checkout.",
            });
          }

          const checkout = yield* payableCheckout
            .open({
              payStateToken: input.payStateToken,
              page: { locale },
              blockPaymentRetry:
                !input.method && qrPayments
                  ? (reservationId) =>
                      qrPayments
                        .findPaymentWindow(reservationOrderId(reservationId))
                        .pipe(Effect.map((window) => window !== null))
                  : undefined,
            })
            .pipe(
              Effect.catchTags({
                PayStateTokenError: (cause) =>
                  Effect.fail(toInvalidPayStateError(cause)),
                CheckoutUnavailableError: (unavailable) =>
                  Effect.succeed(unavailable),
              })
            );
          if (checkout instanceof CheckoutUnavailableError) {
            return yield* recoverUnpayableOrder({
              unavailable: checkout,
              locale,
            });
          }
          const { state, reservation } = checkout;
          yield* Effect.annotateLogsScoped({
            orderId: state.orderId,
            checkoutSessionId: state.checkoutSessionId,
            reservationKind: state.reservation.kind,
            ...reservationLogFields(reservation),
          });
          yield* Effect.logInfo("Hosted payment checkout pay state opened");

          const data = state.reservation;
          const entryPackFunded =
            "entryPack" in state.quote && Boolean(state.quote.entryPack);
          if (entryPackFunded && input.method === "qr") {
            return yield* new CheckoutError({
              code: "checkout_failed",
              message: "Entry pack add-ons are payable by card.",
            });
          }

          if (input.method && !entryPackFunded) {
            const resumed = yield* resumePublicPayment(
              {
                reservationId: reservation.id,
                method: input.method,
                fio: input.fio,
              },
              locale
            );
            if (resumed) return resumed;
          }

          const progressResult = yield* findReservationProgressResult({
            method: input.method,
            reservation,
            state,
            locale,
            returnTarget: input.returnTarget,
          });
          if (progressResult) return progressResult;

          yield* ensureReservationHasNotEnded(state.reservation);

          if (state.changedKeys) {
            return yield* getPendingPricingReviewResult({
              checkout,
              changedKeys: state.changedKeys,
            });
          }

          const { dotyposCustomerId, verdict } = yield* affirmSignedPricing({
            checkout,
            locale,
          });

          const repricedResult = yield* findRepricedResult({
            checkout,
            verdict,
          });
          if (repricedResult) return repricedResult;
          const prepared = verdict.priced;
          yield* Effect.logDebug(
            "Hosted payment checkout quote comparison passed"
          );

          const contractAt = Temporal.Now.instant();
          const earlyPerformanceRequired = isEarlyPerformanceRequestRequired({
            reservation: state.reservation,
            contractAt,
          });

          if (
            earlyPerformanceRequired &&
            input.earlyPerformanceConsent !== true
          ) {
            yield* Effect.logInfo(
              "Hosted payment checkout rejected: missing early performance consent"
            );

            return yield* new CheckoutError({
              code: "early_performance_consent_required",
              message: "Early performance consent is required before checkout.",
            });
          }

          // The full state-creating section runs inside the account
          // advisory lock: authority is re-checked under the lock and the
          // same lock is held until the section completes, so deletion
          // cannot interleave with the reservation update, legal evidence,
          // or payment start, and the account's submissions of one order
          // record its evidence and start its payment once. Attempt
          // admission locks the order's row, so no submission starts a
          // second attempt. Idempotent recovery paths above stay reachable
          // without the lock.
          return yield* accountSections
            .withOptionalAccount(
              Effect.fn(function* () {
                // Another submission of this order may have started its
                // payment, or the hold may have changed, since the check
                // above: decide again under the account lock, before any
                // evidence or provider work.
                const lockedReservation = yield* reservations.findById(
                  reservation.id
                );
                // An order gone meanwhile can't be paid; the status page
                // tells the customer what happened to it.
                if (!lockedReservation) {
                  return { status: "in_progress" as const };
                }
                if (input.method && !entryPackFunded) {
                  const resumed = yield* resumePublicPayment(
                    {
                      reservationId: reservation.id,
                      method: input.method,
                      fio: input.fio,
                    },
                    locale
                  );
                  if (resumed) return resumed;
                }
                const lockedProgressResult =
                  yield* findReservationProgressResult({
                    method: input.method,
                    reservation: lockedReservation,
                    state,
                    locale,
                    returnTarget: input.returnTarget,
                  });
                if (lockedProgressResult) return lockedProgressResult;

                yield* reservations.updateReservationDetails({
                  id: reservation.id,
                  reservationDetails:
                    getStoredWorkspaceReservationDetails(data),
                  locale,
                });

                const legalEvidence = getPaymentSubmitLegalEvidence({
                  locale,
                  acceptedAt: contractAt.toString(),
                  earlyPerformanceConsent: earlyPerformanceRequired,
                });
                const checkoutDetails = getCheckoutDetails({
                  locale,
                  priced: prepared,
                  legalEvidence,
                });
                yield* Effect.annotateLogsScoped({
                  acceptedDocumentCount: Object.keys(legalEvidence).length,
                  earlyPerformanceRequested: earlyPerformanceRequired,
                });
                yield* Effect.logInfo(
                  "Hosted payment checkout legal evidence recording started"
                );
                yield* legalEvidenceEvents.recordMany(
                  Object.values(checkoutDetails.legal).map((evidence) => ({
                    workspaceReservationId: reservation.id,
                    evidence,
                  }))
                );
                yield* Effect.logInfo(
                  "Hosted payment checkout legal evidence recorded"
                );

                const { dotyposReservationId } = reservation;

                yield* dotypos.updateReservation({
                  reservationId: dotyposReservationId,
                  note: formatWorkspaceReservationNote({
                    paymentOrderId: reservation.id,
                    checkoutDetails,
                    reservation: checkoutDetails.reservation,
                  }),
                });
                yield* Effect.logInfo(
                  "Hosted payment checkout Dotypos reservation note updated"
                );

                yield* ensureReservationHasNotEnded(state.reservation);
                const accountingSnapshot = makeAccountingDocumentSnapshot({
                  workspaceReservationId: reservation.id,
                  dotyposReservationId,
                  dotyposCustomerId,
                  locale,
                  prepared,
                });
                const expectedPrice = prepared.quote.payment.expectedPrice;
                const eligibleFio =
                  input.method &&
                  input.fio &&
                  !entryPackFunded &&
                  !lockedReservation.agentClientId &&
                  !checkout.retriedAttempt &&
                  expectedPrice.currency === "CZK" &&
                  providers.activeProviders.includes("nexi")
                    ? input.fio
                    : undefined;
                const startQrPayment = Effect.gen(function* () {
                  if (!eligibleFio || !lifecycle || !qrPayments || !fioWake) {
                    return yield* new CheckoutError({
                      code: "checkout_failed",
                      message:
                        "QR transfer is unavailable for this reservation.",
                    });
                  }
                  yield* reconfirmPayableCheckout(checkout);
                  yield* lifecycle
                    .createPendingQrAttempt({
                      orderId: reservationOrderId(reservation.id),
                      amount: expectedPrice,
                      commitment: prepared.commitment,
                      locale,
                      accountingSnapshot,
                      publicPayment: eligibleFio,
                    })
                    .pipe(Effect.provideService(FioPollWake, fioWake));
                  return yield* readQrPayment(reservation.id);
                });
                const startPayment = Effect.gen(function* () {
                  if (expectedPrice.value === 0) {
                    return yield* completeInternalPayment({
                      workspaceReservationId: reservation.id,
                      locale,
                      total: expectedPrice,
                      commitment: prepared.commitment,
                      accountingSnapshot,
                      reservation: state.reservation,
                      checkout,
                    });
                  }
                  if (input.method === "qr") return yield* startQrPayment;
                  return yield* startProviderSession({
                    workspaceReservationId: reservation.id,
                    correlationId: reservation.correlationId,
                    locale,
                    total: expectedPrice,
                    commitment: prepared.commitment,
                    customer: getPaymentCustomer({
                      id: dotyposCustomerId,
                      name: data.name,
                      email: data.email,
                      // Read in the region of the locale the Pay
                      // state was prepared, and its phone validated, in.
                      phone: parsePhoneNumber(
                        data.phone,
                        defaultPhoneRegion(state.locale)
                      ),
                    }),
                    accountingSnapshot,
                    reservation: state.reservation,
                    returnTarget: input.returnTarget,
                    checkout,
                    fio: eligibleFio,
                  });
                });

                return yield* startPayment.pipe(
                  Effect.catchTag(
                    "DiscountClaimError",
                    Effect.fn(function* (cause) {
                      yield* Effect.logError(
                        "Accepted discount claim admission changed the payable price",
                        {
                          discountBoundary: "claim_admission",
                          discountOperation: cause.operation,
                          discountErrorReason: cause.reason,
                        }
                      );
                      // The claim moved the price after it was affirmed, so
                      // the customer reviews the re-priced order whatever
                      // it compares to: no verdict, only the changed keys.
                      const refreshed = yield* pricing.repriceForPayment({
                        ...state,
                        bookedAt: PayState.bookedAt(state),
                        dotyposCustomerId,
                        locale,
                      });
                      const refreshedSummary = refreshed.summary;
                      const changedKeys = getCheckoutSummaryChangedKeys(
                        PayState.summary(state),
                        refreshedSummary
                      );
                      const refreshedCheckoutDetails = getCheckoutDetails({
                        locale,
                        priced: refreshed,
                        legalEvidence,
                      });
                      yield* dotypos.updateReservation({
                        reservationId: dotyposReservationId,
                        note: formatWorkspaceReservationNote({
                          paymentOrderId: reservation.id,
                          checkoutDetails: refreshedCheckoutDetails,
                          reservation: refreshedCheckoutDetails.reservation,
                        }),
                      });
                      const priceReviewPayState =
                        yield* reissuePriceReviewPayState(checkout.state, {
                          kind: "repriced",
                          verdict: {
                            status: "pricing_changed",
                            priced: refreshed,
                            changedKeys,
                          },
                        }).pipe(provideSealedStateKeys);

                      return {
                        status: "pricing_changed" as const,
                        changedKeys,
                        freshSummary: refreshedSummary,
                        ...priceReviewPayState,
                      };
                    })
                  )
                );
              })
            )
            .pipe(
              Effect.catchTag(
                "CustomerAccountAccessError",
                () =>
                  new CheckoutError({
                    code: "checkout_failed",
                    message:
                      "Reservation checkout is unavailable for this account.",
                  })
              )
            );
        },
        (effect, input, locale) =>
          effect.pipe(
            Effect.scoped,
            Effect.annotateLogs({
              locale,
              hasPayStateToken: input.payStateToken.length > 0,
            }),
            Effect.mapError(mapCheckoutFailure)
          )
      );

      return CheckoutService.of({
        createHostedPaymentCheckout: (input, locale) =>
          submitCheckout(input, locale).pipe(
            Effect.map((result) =>
              result.status === "qr_pending" ? paymentInProgress : result
            )
          ),
        startReservationPayment: submitCheckout,
        resumeReservationPayment: (input, locale) =>
          resumePublicPayment(input, locale).pipe(
            Effect.map((result) => result ?? paymentInProgress)
          ),
      });
    })
  );
}
