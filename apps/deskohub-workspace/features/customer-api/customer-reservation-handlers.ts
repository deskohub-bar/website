import "server-only";

import {
  CurrentCustomerSession,
  CustomerAccessCodeUnavailable,
  CustomerAccountLinkRequired,
  type CustomerBookedSelection,
  type CustomerEstablishment,
  CustomerInvitationResendRefused,
  CustomerInvoiceNotIssued,
  type CustomerOrderState,
  type CustomerPaymentPage,
  CustomerPaymentPageClosed,
  type CustomerPaymentRetryBilling,
  CustomerPaymentRetryRefused,
  type CustomerReservationAccess,
  type CustomerReservationHistory,
  CustomerReservationNotFound,
  type CustomerReservationOrderId,
  type CustomerReservationSummary,
  CustomerSessionRequired,
  CustomerTeamTableProduct,
  type CustomerTeamTableStatus,
  CustomerWithdrawalNameRequired,
  type CustomerWithdrawalQuote,
  type CustomerWithdrawalReceipt,
  CustomerWithdrawalRefundChanged,
  CustomerWithdrawalRefused,
  WorkspaceCustomerApi,
} from "@deskohub/workspace-customer-api";
import { Effect, Layer, Match, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  currentReservationHistoryAccount,
  type CustomerReservationHistory as ReservationHistoryRecord,
  type CustomerReservationSummary as ReservationSummaryRecord,
} from "@/features/account";
import { requireAccountFeature } from "@/features/account/backend/account-feature-withheld";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { CustomerReservationHistoryWithAccessService } from "@/features/account/backend/customer-reservation-history-with-access.service";
import { getReservationSummaryStay } from "@/features/account/reservation-summary-stay";
import { ReservationInvoicePdfService } from "@/features/accounting/backend/reservation-invoice-pdf.service";
import { loadAuthorizedCheckoutStatus } from "@/features/checkout/backend/checkout/authorized-checkout-status";
import {
  CheckoutPaymentPageService,
  type PaymentPageReopening,
} from "@/features/checkout/backend/checkout/checkout-payment-page.service";
import {
  CheckoutPaymentRetryService,
  type PaymentRetryPreparation,
} from "@/features/checkout/backend/checkout/checkout-payment-retry.service";
import type { CheckoutStatusViewModel } from "@/features/checkout/backend/checkout/checkout-status.service";
import { defaultLocale } from "@/features/i18n";
import type { RebookingSelection } from "@/features/reservation/backend/booking-selection";
import {
  ReservationAccessService,
  type ReservationAccessViewModel,
} from "@/features/reservation/backend/reservation-access.service";
import type { ReservationAuthorizationService } from "@/features/reservation/backend/reservation-authorization.service";
import type { ReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { tableReservationDetailsSchema } from "@/features/reservation/table-reservation";
import { getTableReservationDurationMinutes } from "@/features/reservation/table-reservation-time";
import { resendAuthorizedReservationInvitation } from "@/features/reservation-invitees/backend/resend-reservation-invitation";
import {
  type ContractWithdrawal,
  WithdrawalRepository,
} from "@/features/withdrawal/backend/withdrawal.repository";
import {
  WithdrawalNameRequiredError,
  WithdrawalRefusedError,
  WithdrawalService,
} from "@/features/withdrawal/backend/withdrawal.service";
import { WithdrawalReleaseGate } from "@/features/withdrawal/backend/withdrawal-release-gate";
import { reservationWithdrawalRefundBasis } from "@/features/withdrawal/withdrawal-assessment";
import {
  toWithdrawalQuoteData,
  toWithdrawalReceiptData,
} from "@/features/withdrawal/withdrawal-read-model";
import { providePerRequest } from "@/shared/backend/provide-per-request";
import { runToCompletion } from "@/shared/backend/run-to-completion";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  workspaceFormattedAddress,
  workspaceGoogleDirectionsUrl,
  workspaceGoogleMapUrl,
} from "@/shared/utils/workspace-location-map";
import {
  answerCustomerApiFailure,
  answerOccurredFailure,
  answerSessionApiFailure,
  answerUnavailable,
  type CustomerApiFailure,
  type PossibleFailureAnswer,
} from "./customer-api-failure";
import { toCustomerCheckout } from "./customer-checkout-view";
import { answerFileDownload } from "./customer-file-download";
import { CustomerInvitedReservationsService } from "./customer-invited-reservations.service";
import {
  CustomerReservationLayers,
  type CustomerReservationServiceLayers,
} from "./customer-reservation-layers";

/**
 * The reservations group's handlers. Each endpoint builds its operation's
 * Layers per request from `CustomerReservationLayers`, and answers every
 * failure with the contract's fixed public errors. An order the account may
 * not see is not found, exactly like one that doesn't exist. The API
 * presents only the session, never an emailed capability link, so
 * authorization ignores the locale it gets, the default.
 */
export const CustomerReservationsApiHandlers = HttpApiBuilder.group(
  WorkspaceCustomerApi,
  "reservations",
  Effect.fn(function* (handlers) {
    const reservations = yield* CustomerReservationLayers;
    // The authentication the session middleware read the request through.
    const authentication = Layer.succeed(
      CustomerAuthentication,
      yield* CustomerAuthentication
    );
    const authorization = reservations.authorization.pipe(
      Layer.provide(authentication)
    );
    const currentAccount = reservations.currentAccount.pipe(
      Layer.provide(authentication)
    );
    // The gate and the reservation reads behind a withdrawal decide per
    // request, so each request builds them.
    const withdrawalLayer = reservations.withdrawals.pipe(
      Layer.provide(authentication)
    );

    return (
      handlers
        // Showing today's door code can issue it at the lock provider and
        // store it, so the list ends even when the client disconnects.
        .handle("listReservations", ({ query: { locale = defaultLocale } }) =>
          Effect.flatMap(CurrentCustomerSession, (session) =>
            currentReservationHistoryAccount(session.accountId)
          ).pipe(
            Effect.flatMap((account) =>
              Effect.flatMap(
                CustomerReservationHistoryWithAccessService,
                (histories) => histories.load(account, { locale })
              )
            ),
            Effect.provide(
              Layer.mergeAll(
                currentAccount,
                reservations.history(authorization)
              )
            ),
            runToCompletion,
            answerCustomerApiFailure("customerApi.listReservations"),
            Effect.flatMap(answerReservationHistory)
          )
        )
        .handle("getEstablishment", () => Effect.succeed(establishment))
        .handle(
          "listInvitedReservations",
          ({ query: { locale = defaultLocale } }) =>
            Effect.flatMap(CustomerInvitedReservationsService, (invitations) =>
              invitations.load(locale)
            ).pipe(
              Effect.provide(
                reservations.invitedReservations(
                  reservations.access(authorization),
                  currentAccount
                )
              ),
              runToCompletion,
              Effect.catch((failure) =>
                answerUnavailable("customerApi.listInvitedReservations", {
                  reason: failure._tag,
                })
              )
            )
        )
        .handle("resendInvitation", ({ params: { orderId, inviteeId } }) =>
          resendAuthorizedReservationInvitation({
            orderId,
            inviteeId,
            locale: defaultLocale,
          }).pipe(
            providePerRequest(
              Layer.mergeAll(reservations.invitationResend, authorization)
            ),
            Effect.catchTag(
              "InvitationResendRefused",
              (
                error
              ): Effect.Effect<
                never,
                CustomerReservationNotFound | CustomerInvitationResendRefused
              > => {
                const { refusal } = error;
                if (refusal.reason === "not-found") {
                  return Effect.fail(new CustomerReservationNotFound());
                }
                return Effect.fail(
                  new CustomerInvitationResendRefused(
                    refusal.reason === "cooldown"
                      ? {
                          reason: "cooldown",
                          retryAt: refusal.retryAt.toString(),
                        }
                      : { reason: "not-confirmed" }
                  )
                );
              }
            ),
            Effect.map(({ invitationSentAt, resendAvailableAt }) => ({
              invitationSentAt: invitationSentAt.toString(),
              resendAvailableAt: resendAvailableAt.toString(),
            })),
            Effect.catchIf(
              (failure) =>
                failure._tag !== "CustomerReservationNotFound" &&
                failure._tag !== "CustomerInvitationResendRefused",
              (failure) =>
                answerUnavailable("customerApi.resendInvitation", {
                  reason: failure._tag,
                })
            )
          )
        )
        // A refresh can finalize a payment, so it ends even when the client
        // disconnects.
        // The withdrawal record is read beside the status, so it adds no
        // wait; an order the account may not see drops it unanswered.
        .handle("getReservationStatus", ({ params: { orderId } }) =>
          readCustomerReservationStatus(
            orderId,
            reservations,
            authorization
          ).pipe(
            answerSessionApiFailure("customerApi.getReservationStatus"),
            Effect.flatMap(([state, withdrawal]) =>
              answerOrderState(state, withdrawal)
            )
          )
        )
        .handle("reopenPaymentPage", ({ params: { orderId }, payload }) =>
          Effect.flatMap(CheckoutPaymentPageService, (paymentPages) =>
            paymentPages.reopen({
              orderId,
              locale: defaultLocale,
              ...(payload.returnTarget !== undefined && {
                returnTarget: payload.returnTarget,
              }),
            })
          ).pipe(
            Effect.provide(reservations.paymentPage(authorization)),
            answerSessionApiFailure("customerApi.reopenPaymentPage"),
            Effect.flatMap(answerPaymentPage)
          )
        )
        // Securing the hold can book the spot again in Dotypos, so it ends
        // even when the client disconnects.
        .handle("retryPayment", ({ params: { orderId }, payload }) =>
          Effect.flatMap(CheckoutPaymentRetryService, (retries) =>
            retries.prepare({ orderId, locale: payload.locale })
          ).pipe(
            Effect.provide(reservations.paymentRetry(authorization)),
            runToCompletion,
            answerSessionApiFailure("customerApi.retryPayment"),
            Effect.flatMap(answerPaymentRetry)
          )
        )
        // Showing a code can issue it at the lock provider and store it, so
        // it ends even when the client disconnects.
        .handle("getReservationAccess", ({ params: { orderId } }) =>
          Effect.flatMap(ReservationAccessService, (access) =>
            access.getAccess({ orderId, locale: defaultLocale })
          ).pipe(
            Effect.provide(reservations.access(authorization)),
            runToCompletion,
            answerSessionApiFailure("customerApi.getReservationAccess"),
            Effect.flatMap(answerReservationAccess)
          )
        )
        .handle(
          "getWithdrawalQuote",
          ({ params: { orderId }, query: { locale = defaultLocale } }) =>
            withSignedInWithdrawals((withdrawals, accountId) =>
              withdrawals.quote({
                accountId,
                locale,
                contract: { kind: "reservation", id: orderId },
              })
            ).pipe(
              providePerRequest(withdrawalLayer),
              answerWithdrawalFailure("customerApi.getWithdrawalQuote"),
              Effect.map((quote): typeof CustomerWithdrawalQuote.Type => ({
                ...toWithdrawalQuoteData(quote),
                contractId: orderId,
                refundBasis: reservationWithdrawalRefundBasis(
                  quote.refundBasis
                ),
              }))
            )
        )
        // The withdrawal is recorded before the response, and ending the
        // booking follows it, so it ends even when the client disconnects.
        .handle("withdrawFromReservation", ({ params: { orderId }, payload }) =>
          withSignedInWithdrawals((withdrawals, accountId) =>
            withdrawals
              .withdraw({
                accountId,
                locale: payload.locale,
                contract: { kind: "reservation", id: orderId },
                ...(payload.customerName !== undefined && {
                  customerName: payload.customerName,
                }),
                ...(payload.refundTermsKey !== undefined && {
                  refundTermsKey: payload.refundTermsKey,
                }),
              })
              .pipe(
                Effect.map((receipt) => ({
                  kind: "receipt" as const,
                  receipt,
                })),
                Effect.catchTag("WithdrawalRefundChangedError", ({ quote }) =>
                  Effect.succeed({ kind: "refund_changed" as const, quote })
                )
              )
          ).pipe(
            providePerRequest(withdrawalLayer),
            runToCompletion,
            answerWithdrawalFailure("customerApi.withdrawFromReservation"),
            Effect.flatMap((result) =>
              result.kind === "receipt"
                ? Effect.succeed<CustomerWithdrawalReceipt>(
                    toWithdrawalReceiptData(result.receipt)
                  )
                : Effect.fail(customerWithdrawalRefundChanged(result.quote))
            )
          )
        )
        .handle("getReservationInvoice", ({ params: { orderId } }) =>
          Effect.flatMap(ReservationInvoicePdfService, (invoices) =>
            invoices.getPdf({ orderId, locale: defaultLocale })
          ).pipe(
            Effect.provide(reservations.invoice(authorization)),
            Effect.catchTags(
              {
                ReservationInvoiceNotFoundError: () =>
                  Effect.fail(new CustomerReservationNotFound()),
                ReservationInvoiceNotIssuedError: () =>
                  Effect.fail(new CustomerInvoiceNotIssued()),
              },
              (failure) =>
                answerSessionApiFailure("customerApi.getReservationInvoice")(
                  Effect.fail(failure)
                )
            ),
            Effect.map(answerFileDownload("application/pdf"))
          )
        )
    );
  })
);

/**
 * Runs a withdrawal operation for the session's account while the online
 * withdrawal function is released.
 */
const withSignedInWithdrawals = <A, E>(
  operation: (
    withdrawals: WithdrawalService["Service"],
    accountId: CustomerReservationAccountId
  ) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    yield* requireAccountFeature("withdrawal", WithdrawalReleaseGate.isOpen);
    const session = yield* CurrentCustomerSession;
    const withdrawals = yield* WithdrawalService;
    return yield* operation(withdrawals, session.accountId);
  });

type CustomerReservationAccountId = Parameters<
  WithdrawalService["Service"]["quote"]
>[0]["accountId"];

const customerWithdrawalRefundChanged = (
  quote: Parameters<typeof toWithdrawalQuoteData>[0]
) => {
  const {
    paidAmount,
    refundAmount,
    refundBasis,
    refundTermsKey,
    periodEndsAt,
  } = toWithdrawalQuoteData(quote);
  return new CustomerWithdrawalRefundChanged({
    quote: {
      paidAmount,
      refundAmount,
      refundBasis: reservationWithdrawalRefundBasis(refundBasis),
      refundTermsKey,
      periodEndsAt,
    },
  });
};

/** The public errors a withdrawal operation failing with `E` answers. */
type WithdrawalFailureAnswer<E> =
  | CustomerReservationNotFound
  | CustomerWithdrawalRefused
  | PossibleFailureAnswer<
      Extract<E, WithdrawalNameRequiredError>,
      CustomerWithdrawalNameRequired
    >
  | CustomerApiFailure<
      Exclude<E, WithdrawalRefusedError | WithdrawalNameRequiredError>
    >;

const isWithdrawalNameRequired = <E>(
  failure: E
): failure is Extract<E, WithdrawalNameRequiredError> =>
  failure instanceof WithdrawalNameRequiredError;

const isOtherWithdrawalFailure = <E>(
  failure: E
): failure is Exclude<
  E,
  WithdrawalRefusedError | WithdrawalNameRequiredError
> =>
  !(
    failure instanceof WithdrawalRefusedError ||
    failure instanceof WithdrawalNameRequiredError
  );

/**
 * Answers a refused withdrawal with its public reason, an order the account
 * didn't book as not found, a statement without a name as name required, and
 * every other failure as the API's failures.
 */
const answerWithdrawalFailure =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, WithdrawalFailureAnswer<E>, R> =>
    effect.pipe(
      Effect.catch(
        (failure): Effect.Effect<never, WithdrawalFailureAnswer<E>> => {
          if (isWithdrawalNameRequired(failure)) {
            return Effect.fail(
              answerOccurredFailure(
                failure,
                new CustomerWithdrawalNameRequired()
              )
            );
          }
          if (isOtherWithdrawalFailure(failure)) {
            return answerCustomerApiFailure(operation)(Effect.fail(failure));
          }
          return failure instanceof WithdrawalRefusedError &&
            failure.reason !== "not_found"
            ? Effect.fail(
                new CustomerWithdrawalRefused({ reason: failure.reason })
              )
            : Effect.fail(new CustomerReservationNotFound());
        }
      )
    );

/**
 * The history the contract carries. Only the account page's account state
 * degrades a history to unavailable, so each reason answers as the account
 * failure it stands for.
 */
const answerReservationHistory = (history: ReservationHistoryRecord) =>
  Match.value(history).pipe(
    Match.discriminatorsExhaustive("kind")({
      available: ({ groups }) =>
        Effect.succeed<CustomerReservationHistory>({
          current: groups.current.map(answerReservationSummary),
          past: groups.past.map(answerReservationSummary),
          unavailable: groups.unavailable.map(answerReservationSummary),
        }),
      unavailable: ({ reason }) =>
        Match.value(reason).pipe(
          Match.when("provider-unavailable", () =>
            answerUnavailable("customerApi.listReservations", { reason })
          ),
          Match.when("link-required", () =>
            Effect.fail(
              new CustomerAccountLinkRequired({ reason: "profile-missing" })
            )
          ),
          Match.when("email-unverified", () =>
            Effect.fail(new CustomerSessionRequired())
          ),
          Match.exhaustive
        ),
    })
  );

/** A history entry's product, with a cowork booking's stay. */
const answerReservationProduct = (
  reservation: Pick<
    ReservationSummaryRecord,
    "endsAt" | "product" | "seats" | "startsAt"
  >
): CustomerReservationSummary["product"] => {
  const { product } = reservation;
  if (product.kind === "table") {
    const teamTable = teamTableProduct(reservation);
    return { kind: "other", family: "table", ...(teamTable && { teamTable }) };
  }
  const stay = getReservationSummaryStay(reservation);
  return product.kind === "cowork" && stay ? { ...product, stay } : product;
};

/** A history entry as the contract carries it, without unknown fields. */
const answerReservationSummary = ({
  id,
  workspaceReservationId,
  reviewSandbox,
  party,
  product,
  startsAt,
  endsAt,
  setupStartsAt,
  seats,
  status,
  settlement,
  productName,
  accessStartsAt,
  accessEndsAt,
  bookedSelection,
  todayAccess,
  withdrawal,
}: ReservationSummaryRecord): CustomerReservationSummary => ({
  id,
  ...(workspaceReservationId && { orderId: workspaceReservationId }),
  ...(reviewSandbox && { reviewSandbox }),
  ...(party && { party }),
  product: answerReservationProduct({ product, seats, startsAt, endsAt }),
  startsAt,
  endsAt,
  ...(setupStartsAt && { setupStartsAt }),
  seats,
  status,
  ...(settlement && { settlement }),
  ...(productName !== undefined && { productName }),
  ...(accessStartsAt && accessEndsAt && { accessStartsAt, accessEndsAt }),
  ...(bookedSelection && {
    bookedSelection: answerBookedSelection(bookedSelection),
  }),
  ...(todayAccess && {
    todayAccess: {
      code: todayAccess.code,
      accessStartsAt: todayAccess.accessStartsAt,
      accessEndsAt: todayAccess.accessEndsAt,
    },
  }),
  ...(withdrawal && {
    withdrawal: {
      eligible: withdrawal.eligible,
      periodEndsAt: withdrawal.periodEndsAt,
    },
  }),
});

/** A booking selection as `createCheckout` takes it, without unknown fields. */
const answerBookedSelection = ({
  selection: {
    family,
    date,
    endDate,
    startTime,
    duration,
    seats,
    tier,
    stay,
    coffee,
    monitorOption,
  },
  earlySetup,
}: RebookingSelection): CustomerBookedSelection | undefined =>
  family === "table"
    ? undefined
    : {
        selection: {
          family,
          date,
          ...(endDate !== undefined && { endDate }),
          ...(startTime !== undefined && { startTime }),
          ...(duration !== undefined && { duration }),
          ...(seats !== undefined && { seats }),
          ...(tier !== undefined && { tier }),
          ...(stay !== undefined && { stay }),
          ...(coffee !== undefined && { coffee }),
          ...(monitorOption !== undefined && { monitorOption }),
        },
        ...(earlySetup && { earlySetup }),
      };

/** Where the space is, from the site's own location constants. */
const establishment: CustomerEstablishment = {
  name: workspaceSiteConstants.brand.name,
  formattedAddress: workspaceFormattedAddress,
  address: workspaceSiteConstants.location.address,
  coordinates: workspaceSiteConstants.location.coordinates,
  directionsUrl: workspaceGoogleDirectionsUrl,
  mapUrl: workspaceGoogleMapUrl,
};

/** The signed-in status refresh and the order's recorded withdrawal. */
export const readCustomerReservationStatus = <E>(
  orderId: CustomerReservationOrderId,
  reservations: CustomerReservationServiceLayers,
  authorization: Layer.Layer<ReservationAuthorizationService, E>
) =>
  Effect.all(
    [
      loadAuthorizedCheckoutStatus({
        includeSupportContact: false,
        orderId,
        locale: defaultLocale,
        returnOutcome: "unknown",
      }),
      Effect.flatMap(WithdrawalRepository, (withdrawals) =>
        withdrawals.findByContract({ kind: "reservation", id: orderId })
      ),
    ],
    { concurrency: "unbounded" }
  ).pipe(
    providePerRequest(
      Layer.mergeAll(
        reservations.checkoutStatus,
        reservations.withdrawalRecords,
        authorization
      )
    ),
    runToCompletion
  );

const isTeamTableProduct = Schema.is(CustomerTeamTableProduct);
const decodeTableDetails = Schema.decodeUnknownOption(
  tableReservationDetailsSchema
);

/** Older records can lack a readable size or interval. */
const teamTableProduct = (details: {
  readonly seats?: number | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}) =>
  decodeTableDetails({ ...details, kind: "table" }).pipe(
    Option.map((reservation) => ({
      kind: reservation.kind,
      seats: reservation.seats,
      durationMinutes: getTableReservationDurationMinutes(reservation),
    })),
    Option.filter(isTeamTableProduct),
    Option.getOrUndefined
  );

/**
 * An order the account may see, as the contract carries its status, with
 * the customer's withdrawal from it when there is one.
 */
const answerOrderState = (
  state: CheckoutStatusViewModel,
  withdrawal: Option.Option<ContractWithdrawal>
) => {
  if (state.status === "not_found" || state.kind === "table") {
    return Effect.fail(new CustomerReservationNotFound());
  }

  const { kind, bookedSelection } = state;
  return Effect.succeed<CustomerOrderState>({
    ...customerOrderStateFields(state, withdrawal),
    kind,
    ...(bookedSelection && {
      bookedSelection: answerBookedSelection(bookedSelection),
    }),
  });
};

export const answerTeamTableOrderState = (
  state: CheckoutStatusViewModel,
  withdrawal: Option.Option<ContractWithdrawal>
) => {
  if (state.status === "not_found" || state.kind !== "table") {
    return Effect.fail(new CustomerReservationNotFound());
  }

  const product =
    state.summary &&
    teamTableProduct({
      seats: state.summary.seats,
      startsAt: state.summary.reservedFrom.toString(),
      endsAt: state.summary.reservedUntil.toString(),
    });

  return Effect.succeed<CustomerTeamTableStatus>({
    ...customerOrderStateFields(state, withdrawal),
    kind: state.kind,
    ...(product && { product }),
    ...(state.table && { tableName: state.table.name }),
  });
};

const customerOrderStateFields = (
  {
    orderId,
    status,
    paymentStatus,
    fulfillmentStatus,
    reviewSandbox,
    paymentPageReopenable,
    summary,
    ...reservation
  }: Exclude<CheckoutStatusViewModel, { status: "not_found" }>,
  withdrawal: Option.Option<ContractWithdrawal>
): Omit<CustomerOrderState, "kind" | "bookedSelection"> => ({
  orderId,
  status: status === "reservation_cancelled" ? "cancelled" : status,
  paymentStatus,
  fulfillmentStatus,
  ...(status === "reservation_cancelled" && {
    reservationCancelled: true,
  }),
  ...(reviewSandbox && { reviewSandbox }),
  ...(paymentPageReopenable && { paymentPageReopenable }),
  ...(summary && {
    startsAt: summary.reservedFrom.toString(),
    endsAt: summary.reservedUntil.toString(),
    ...("setupFrom" in summary &&
      summary.setupFrom && {
        setupStartsAt: summary.setupFrom.toString(),
      }),
    total: {
      value: summary.price.value,
      exponent: summary.price.exponent,
      currency: summary.price.currency,
    },
  }),
  ...("people" in reservation &&
    reservation.people && {
      people: {
        contactAttends: reservation.people.contactAttends,
        resendable: Option.isNone(withdrawal) && reservation.people.resendable,
        invitees: reservation.people.invitees.map(
          ({ id, email, invitationSentAt, resendAvailableAt }) => ({
            id,
            email,
            invitationSentAt: invitationSentAt?.toString() ?? null,
            ...(Option.isNone(withdrawal) &&
              resendAvailableAt && {
                resendAvailableAt: resendAvailableAt.toString(),
              }),
          })
        ),
      },
    }),
  ...Option.match(withdrawal, {
    onNone: () => ({}),
    onSome: ({ submittedAt, refundAmount }) => ({
      withdrawal: {
        submittedAt: submittedAt.toString(),
        refundAmount: {
          value: refundAmount.value,
          exponent: refundAmount.exponent,
          currency: refundAmount.currency,
        },
      },
    }),
  }),
});

/** The payment page to open again, or why the order has none. */
const answerPaymentPage = (reopening: PaymentPageReopening) =>
  Match.value(reopening).pipe(
    Match.discriminatorsExhaustive("state")({
      opened: ({ providerRedirectUrl }) =>
        Effect.succeed<CustomerPaymentPage>({ url: providerRedirectUrl }),
      not_found: () => Effect.fail(new CustomerReservationNotFound()),
      closed: ({ reason }) =>
        Effect.fail(new CustomerPaymentPageClosed({ reason })),
    })
  );

/**
 * The same order's checkout to pay again with the details it keeps, or why
 * it can't be paid again in place; the app then books the selection again
 * or, while the earlier payment may still settle, checks the status later.
 */
const answerPaymentRetry = (preparation: PaymentRetryPreparation) =>
  Match.value(preparation).pipe(
    Match.discriminatorsExhaustive("state")({
      ready: ({ checkout, payState, details }) =>
        Effect.succeed({
          ...toCustomerCheckout(checkout, payState.freshPayStateToken),
          details: {
            bookingFor: details.bookingFor,
            contact: details.contact,
            billing: toPaymentRetryBilling(details.billing),
          },
        }),
      not_found: () => Effect.fail(new CustomerReservationNotFound()),
      not_retryable: ({ reason }) =>
        Effect.fail(new CustomerPaymentRetryRefused({ reason })),
      spot_unavailable: () =>
        Effect.fail(
          new CustomerPaymentRetryRefused({ reason: "spot_unavailable" })
        ),
      payment_settling: () =>
        Effect.fail(
          new CustomerPaymentRetryRefused({ reason: "payment_settling" })
        ),
    })
  );

/**
 * The kept billing as the app's review shows it: a personal invoice's city or
 * the invoiced company's name, without the rest of the invoice's details.
 */
const toPaymentRetryBilling = (
  billing: ReservationBillingSelection
): CustomerPaymentRetryBilling =>
  Match.value(billing).pipe(
    Match.discriminatorsExhaustive("invoice")({
      none: () => ({ purpose: "personal", invoice: "none" }) as const,
      requested: ({ address }) =>
        ({
          purpose: "personal",
          invoice: "requested",
          city: address.city,
        }) as const,
      required: ({ buyer }) =>
        ({
          purpose: "business",
          invoice: "required",
          legalName: buyer.legalName,
        }) as const,
    })
  );

/**
 * The door code, when the account may see it and the order has one. An
 * order whose code can't be read now, though it may have one, is
 * unavailable rather than without a code.
 */
const answerReservationAccess = (access: ReservationAccessViewModel) =>
  Match.value(access).pipe(
    Match.discriminatorsExhaustive("state")({
      available: ({ code, accessStartsAt, accessEndsAt, teamTable }) =>
        Effect.succeed<CustomerReservationAccess>({
          code,
          accessStartsAt: accessStartsAt.toString(),
          accessEndsAt: accessEndsAt.toString(),
          ...(teamTable?.name && { tableName: teamTable.name }),
        }),
      invalid_link: () => Effect.fail(new CustomerReservationNotFound()),
      unavailable: ({ reason }) =>
        Match.value(reason).pipe(
          Match.when("reservation-state", () =>
            Effect.fail(new CustomerAccessCodeUnavailable())
          ),
          Match.when("lookup-failed", () =>
            answerUnavailable("customerApi.getReservationAccess", { reason })
          ),
          Match.exhaustive
        ),
    })
  );
