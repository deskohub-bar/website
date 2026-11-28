import "server-only";

import {
  CustomerBookingDateOutOfRange,
  CustomerBookingSelectionInvalid,
  CustomerReservationNotFound,
  type CustomerServiceUnavailable,
  type CustomerTeamTableCalendar,
  CustomerTeamTableInvitationRejected,
  type CustomerTeamTableOfferings,
  type CustomerTeamTableQuote,
  type CustomerTeamTableSelection,
  CustomerTeamTableUnavailable,
  customerAvailabilityReplacementHeader,
  customerReferralCodeHeader,
  WorkspaceCustomerApiWithTeamTable,
} from "@deskohub/workspace-customer-api";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { buildAdvertisedPrice } from "@/features/checkout/backend/checkout/advertised-price.server";
import type { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import type { Locale } from "@/features/i18n";
import type { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { resolveBookingQuoteSelection } from "@/features/reservation/backend/booking-selection";
import {
  AvailabilityQueryInvalid,
  TeamTableAvailabilityClosed,
  WorkspaceAvailabilityService,
} from "@/features/reservation/backend/workspace-availability.service";
import {
  loadAvailability,
  loadTableSlots,
} from "@/features/reservation/backend/workspace-availability-loader";
import {
  type BookableDates,
  getBookableDates,
} from "@/features/reservation/bookable-dates";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { getTableReservationProductIdentity } from "@/features/reservation/table-reservation";
import {
  getTableAvailabilityQuery,
  getTableSlotsQuery,
} from "@/features/reservation/workspace-availability";
import { addAuthorizedReservationInvitees } from "@/features/reservation-invitees/backend/add-reservation-invitees";
import { loadTeamTableOfferings } from "@/features/team-table/backend/team-table-offerings";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import { providePerRequest } from "@/shared/backend/provide-per-request";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  answerSessionApiFailure,
  answerUnavailable,
  type CustomerSessionApiFailure,
} from "./customer-api-failure";
import {
  customerQuoteFields,
  SalePricesUnavailable,
} from "./customer-booking-catalog-handlers";
import { CustomerBookingCatalogLayers } from "./customer-booking-catalog-layers";
import { customerTeamTableCheckout } from "./customer-booking-checkout-handlers";
import {
  answerTeamTableSelectionFailure,
  requireCustomerTeamTableRelease,
  toBookingSelectionInput,
} from "./customer-booking-selection";
import {
  answerTeamTableOrderState,
  readCustomerReservationStatus,
} from "./customer-reservation-handlers";
import { CustomerReservationLayers } from "./customer-reservation-layers";

export const CustomerTeamTableApiHandlers = HttpApiBuilder.group(
  WorkspaceCustomerApiWithTeamTable,
  "teamTable",
  Effect.fn(function* (handlers) {
    const {
      pricing,
      inventory,
      availability,
      sealedStateKeys,
      releases,
      teamTableRelease,
    } = yield* CustomerBookingCatalogLayers;
    const createCheckout = yield* customerTeamTableCheckout;
    const reservations = yield* CustomerReservationLayers;
    const authentication = Layer.succeed(
      CustomerAuthentication,
      yield* CustomerAuthentication
    );
    const authorization = reservations.authorization.pipe(
      Layer.provide(authentication)
    );
    const catalog = Layer.mergeAll(
      pricing.pipe(Layer.provideMerge(releases.referral)),
      inventory
    );
    const quoting = Layer.mergeAll(
      catalog,
      availability,
      sealedStateKeys,
      releases.office,
      releases.overnightStay
    );
    const withBookingRelease = <A, E, R>(booking: Effect.Effect<A, E, R>) =>
      requireCustomerTeamTableRelease.pipe(
        Effect.andThen(booking),
        providePerRequest(teamTableRelease)
      );

    return handlers
      .handle("listOfferings", ({ query: { locale } }) =>
        listOfferings(locale, catalog).pipe(
          providePerRequest(teamTableRelease),
          answerSessionApiFailure("customerApi.listTeamTableOfferings")
        )
      )
      .handle("getAvailability", ({ query, headers }) =>
        withBookingRelease(
          Effect.gen(function* () {
            const dates = yield* tableBookableDates;
            const from = yield* availabilityDate(
              query.from ?? dates.earliest,
              "from",
              dates
            );
            const to = yield* availabilityDate(
              query.to ?? dates.latest,
              "to",
              dates
            );
            if (from > to) {
              return yield* new CustomerBookingSelectionInvalid({
                field: "to",
              });
            }
            const { unavailableDates } = yield* loadAvailability({
              query: {
                ...getTableAvailabilityQuery({
                  today: dates.earliest,
                  seats: query.seats,
                }),
                from,
                to,
              },
              replacementToken: headers[customerAvailabilityReplacementHeader],
            }).pipe(
              providePerRequest(availability),
              answerTeamTableAvailabilityFailure(
                "customerApi.getTeamTableAvailability"
              )
            );
            return {
              from,
              to,
              seats: query.seats,
              unavailableDates,
            } satisfies CustomerTeamTableCalendar;
          })
        )
      )
      .handle("getSlots", ({ query, headers }) =>
        withBookingRelease(
          Effect.gen(function* () {
            const dates = yield* tableBookableDates;
            const date = yield* availabilityDate(query.date, "date", dates);
            const slots = getTableSlotsQuery({ date, seats: query.seats });
            if (Option.isNone(slots)) {
              return yield* new CustomerBookingSelectionInvalid({});
            }
            return yield* loadTableSlots({
              query: slots.value,
              replacementToken: headers[customerAvailabilityReplacementHeader],
            }).pipe(
              providePerRequest(availability),
              answerTeamTableAvailabilityFailure(
                "customerApi.getTeamTableSlots"
              )
            );
          })
        )
      )
      .handle("getQuote", ({ query: { locale, ...selection } }) =>
        withBookingRelease(
          quoteTeamTable(selection, locale).pipe(
            providePerRequest(quoting),
            answerTeamTableSelectionFailure("customerApi.getTeamTableQuote")
          )
        )
      )
      .handle("createCheckout", ({ payload, headers }) =>
        createCheckout(payload, headers[customerReferralCodeHeader])
      )
      .handle("getStatus", ({ params: { orderId } }) =>
        readCustomerReservationStatus(
          orderId,
          reservations,
          authorization
        ).pipe(
          answerSessionApiFailure("customerApi.getTeamTableStatus"),
          Effect.flatMap(([state, withdrawal]) =>
            answerTeamTableOrderState(state, withdrawal)
          )
        )
      )
      .handle("addInvitees", ({ params: { orderId }, payload }) =>
        addAuthorizedReservationInvitees({ orderId, ...payload }).pipe(
          providePerRequest(
            Layer.mergeAll(reservations.invitationAdd, authorization)
          ),
          Effect.catch(
            (
              failure
            ): Effect.Effect<
              never,
              | CustomerReservationNotFound
              | CustomerServiceUnavailable
              | CustomerTeamTableInvitationRejected
            > => {
              if (failure._tag !== "InvitationAddRefused") {
                return answerUnavailable("customerApi.addTeamTableInvitees", {
                  reason: failure._tag,
                });
              }
              const { reason } = failure.refusal;
              return reason === "not-found"
                ? Effect.fail(new CustomerReservationNotFound())
                : Effect.fail(
                    new CustomerTeamTableInvitationRejected({ reason })
                  );
            }
          )
        )
      );
  })
);

const tableBookableDates = currentInstant.pipe(
  Effect.map((now) => getBookableDates("table", getCurrentWorkspaceDate(now)))
);
const isPlainDate = Schema.is(plainDateStringSchema);

const answerTeamTableAvailabilityFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch(
        (
          failure
        ): Effect.Effect<
          never,
          | CustomerBookingSelectionInvalid
          | CustomerTeamTableUnavailable
          | CustomerSessionApiFailure<E>
        > => {
          if (failure instanceof TeamTableAvailabilityClosed) {
            return Effect.fail(new CustomerTeamTableUnavailable());
          }
          if (failure instanceof AvailabilityQueryInvalid) {
            return Effect.fail(new CustomerBookingSelectionInvalid({}));
          }
          return Effect.fail(failure).pipe(answerSessionApiFailure(operation));
        }
      )
    );

const availabilityDate = (
  date: string,
  field: "date" | "from" | "to",
  range: BookableDates
) => {
  if (!isPlainDate(date)) {
    return Effect.fail(new CustomerBookingSelectionInvalid({ field }));
  }
  return date < range.earliest || date > range.latest
    ? Effect.fail(new CustomerBookingDateOutOfRange(range))
    : Effect.succeed(date);
};

const listOfferings = <E>(
  locale: Locale,
  catalog: Layer.Layer<
    AdvisoryAvailabilityInventory | CheckoutPricingService,
    E
  >
) =>
  Effect.gen(function* () {
    const advertisedOn = getCurrentWorkspaceDate(yield* currentInstant);
    const base = {
      advertisedOn: advertisedOn.toString(),
      bookableDates: getBookableDates("table", advertisedOn),
    };
    if (!(yield* TeamTableReleaseGate.isOpen)) {
      return { ...base, offerings: [] } satisfies CustomerTeamTableOfferings;
    }
    const rows = yield* loadTeamTableOfferings({ advertisedOn, locale }).pipe(
      Effect.filterOrFail(
        (rows) => rows.every(({ discountsComplete }) => discountsComplete),
        () => new SalePricesUnavailable()
      ),
      providePerRequest(catalog)
    );
    return {
      ...base,
      offerings: rows.map(({ discountsComplete, ...offering }) => offering),
    } satisfies CustomerTeamTableOfferings;
  });

const quoteTeamTable = Effect.fn("customerApi.getTeamTableQuote")(function* (
  selection: Omit<CustomerTeamTableSelection, "family">,
  locale: Locale
) {
  const now = yield* currentInstant;
  const resolved = yield* resolveBookingQuoteSelection({
    selection: yield* toBookingSelectionInput({
      family: "table",
      ...selection,
    }),
    locale,
    now,
  });
  const { reservation } = resolved;
  if (reservation.kind !== "table") {
    return yield* new CustomerBookingSelectionInvalid({ field: "family" });
  }
  const availability = yield* WorkspaceAvailabilityService;
  yield* availability.ensureAvailable(reservation);

  const advertised = yield* buildAdvertisedPrice(resolved.request).pipe(
    Effect.filterOrFail(
      ({ discountsComplete }) => discountsComplete,
      () => new SalePricesUnavailable()
    )
  );
  return {
    family: reservation.kind,
    product: getTableReservationProductIdentity(reservation),
    ...customerQuoteFields(advertised, now),
  } satisfies CustomerTeamTableQuote;
});
