import { Effect, Match, Struct } from "effect";
import { CheckoutService } from "@/features/checkout/backend/checkout";
import { CheckoutError } from "@/features/checkout/backend/checkout/checkout-error";
import { readPublicPayStatePayment } from "@/features/checkout/backend/checkout/public-pay-state-author.server";
import { getPublicReservationPaymentAccount } from "@/features/checkout/backend/checkout/public-reservation-payment-account";
import { getReservationStatusPath } from "@/features/checkout/backend/checkout/reservation-status-url";
import { type Locale, m } from "@/features/i18n";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import type { SubmitReservationInput } from "@/features/reservation/actions/submit-reservation-input";
import { WorkspaceTableUnavailableError } from "@/features/reservation/backend/workspace-availability.service";
import { getReservationAvailabilityUnavailableMessage } from "@/features/reservation/reservation.i18n";
import { BotProtectionService } from "@/shared/backend/bot-protection/bot-protection.service";
import { customerAgentNames } from "@/shared/bot-protection/customer-agents";
import { PublicSafeActionError } from "@/shared/utils/safe-action-client";

export const submitWorkspaceReservation = Effect.fn(
  "submitWorkspaceReservation"
)(
  function* (input: SubmitReservationInput) {
    const { locale } = input;
    yield* Effect.annotateLogsScoped({ locale });
    const botProtection = yield* BotProtectionService;
    // Pay submit: the customer's own purchase path, so verified customer
    // agents may start the hosted payment the customer completes.
    yield* botProtection.verifyHuman({
      verificationFailurePolicy: "allow",
      verifiedBots: { allow: customerAgentNames },
      callSite: "reservation.submit",
    });
    const service = yield* CheckoutService;
    const payment = {
      payStateToken: input.payStateToken,
      legalConsent: input.legalConsent,
      earlyPerformanceConsent: input.earlyPerformanceConsent,
    };
    const method = input.method;
    const defaultAccount =
      method && (yield* getPublicReservationPaymentAccount());
    const selectedPayment =
      method &&
      (yield* readPublicPayStatePayment(
        { payStateToken: payment.payStateToken, locale },
        defaultAccount
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              code: "checkout_failed",
              message: "The signed-in reservation author is required.",
              cause,
            })
        )
      ));
    if (
      (method === "qr" && selectedPayment?.kind === "card_only") ||
      (!selectedPayment && (defaultAccount || method === "qr"))
    ) {
      return yield* new CheckoutError({
        code: "checkout_failed",
        message: "The selected payment method is unavailable.",
      });
    }
    const checkout = yield* method && selectedPayment?.kind === "account"
      ? service.startReservationPayment(
          {
            ...payment,
            method,
            fio: { accountKey: selectedPayment.accountKey },
          },
          locale
        )
      : service.createHostedPaymentCheckout(payment, locale);

    if (method === "qr" && checkout.status === "redirect" && !checkout.paid) {
      return yield* new CheckoutError({
        code: "checkout_failed",
        message: "The selected payment method is unavailable.",
      });
    }

    // The signed-in author follows the status page by session, so the
    // checkout sets no access cookie of its own.
    // A paid order records any carried referral, and the booker's first paid
    // order closes their referral window. Booking for someone else keeps the
    // booker's code.
    if (checkout.status === "redirect" && checkout.paid) {
      const remembered = yield* RememberedReferral;
      yield* remembered.forgetIfSettled({ kind: "order", paid: true });
    }

    yield* Effect.logInfo("Workspace checkout started");

    return {
      message: "Checkout started successfully",
      ...toSiteCheckoutResult(checkout, locale),
    };
  },
  (effect, input) =>
    effect.pipe(
      Effect.scoped,
      Effect.tapError(() =>
        Effect.logError("Workspace checkout submission failed")
      ),
      Effect.mapError(
        (error) =>
          new PublicSafeActionError({
            message: Match.value(error).pipe(
              Match.tagsExhaustive({
                BotDetectedError: () =>
                  m.automatedRequestRejected({}, { locale: input.locale }),
                BotVerificationError: () =>
                  m.reservationErrorMessage({}, { locale: input.locale }),
                CheckoutError: (checkoutError) =>
                  Match.value(checkoutError.code).pipe(
                    Match.when("meeting_room_reservation_ended", () =>
                      m.reservationValidationMeetingRoomEnded(
                        {},
                        { locale: input.locale }
                      )
                    ),
                    Match.when("office_reservation_ended", () =>
                      m.reservationValidationOfficeEnded(
                        {},
                        { locale: input.locale }
                      )
                    ),
                    Match.when("cowork_reservation_ended", () =>
                      m.reservationValidationCoworkEnded(
                        {},
                        { locale: input.locale }
                      )
                    ),
                    Match.when("cowork_offer_replaced", () =>
                      m.reservationValidationCoworkOfferReplaced(
                        {},
                        { locale: input.locale }
                      )
                    ),
                    Match.when("checkout_failed", () =>
                      Match.value(checkoutError.cause).pipe(
                        Match.when(
                          Match.instanceOf(WorkspaceTableUnavailableError),
                          (unavailable) =>
                            getReservationAvailabilityUnavailableMessage({
                              date: unavailable.date,
                              locale: input.locale,
                              reservation: unavailable.reservation,
                            })
                        ),
                        Match.orElse(() =>
                          m.reservationErrorMessage(
                            {},
                            { locale: input.locale }
                          )
                        )
                      )
                    ),
                    // Other callers tell missing consents apart; the site
                    // keeps showing its generic checkout failure.
                    Match.whenOr(
                      "legal_consent_required",
                      "early_performance_consent_required",
                      () =>
                        m.reservationErrorMessage({}, { locale: input.locale })
                    ),
                    Match.exhaustive
                  ),
              })
            ),
            cause: error,
          })
      )
    )
);

type ReservationPaymentCheckout = Effect.Success<
  ReturnType<CheckoutService["Service"]["startReservationPayment"]>
>;

/**
 * What the Pay page's form reads from a submission. The checkout's sealed
 * token, its expiry and the order id serve the customer HTTP API; the
 * browser follows `freshPayUrl` and `statusUrl` instead.
 */
const toSiteCheckoutResult = (
  checkout: ReservationPaymentCheckout,
  locale: Locale
) =>
  Match.value(checkout).pipe(
    Match.discriminatorsExhaustive("status")({
      qr_pending: ({ orderId, status }) => ({
        status,
        statusUrl: getReservationStatusPath({ locale, orderId }),
      }),
      redirect: (redirect) =>
        Struct.pick(redirect, ["status", "redirectUrl", "statusUrl", "paid"]),
      pricing_changed: (changed) =>
        Struct.pick(changed, [
          "status",
          "changedKeys",
          "freshSummary",
          "freshPayUrl",
        ]),
      in_progress: (inProgress) => Struct.pick(inProgress, ["status"]),
    })
  );
