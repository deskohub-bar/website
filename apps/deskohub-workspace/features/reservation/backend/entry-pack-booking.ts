import { Effect, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountId } from "@/features/account/customer-account";
import {
  buildAdvertisedPriceState,
  sealAdvertisedPriceState,
} from "@/features/checkout/backend/checkout/advertised-price-state";
import { getCoworkCheckoutSummary } from "@/features/checkout/checkout-summary-cowork";
import { buildCoworkReservationQuote } from "@/features/checkout/reservation-quote-cowork";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import {
  EntryPackUnavailableError,
  loadEntryPackRedemption,
} from "@/features/passes/backend/entry-pack-redemption";
import { getCoworkAdvertisedPriceReservation } from "@/features/reservation/cowork-reservation";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import type { SelectedReservation } from "./booking-selection";

export const requireCoworkPassesRelease = CoworkPassesReleaseGate.isOpen.pipe(
  Effect.filterOrFail(
    (open) => open,
    () => new EntryPackUnavailableError({})
  ),
  Effect.asVoid
);

/** Resolve the holder's pack for the selected tier, including the workstation. */
export const resolveEntryPackBooking = Effect.fn("resolveEntryPackBooking")(
  function* (input: {
    readonly reservation: Extract<SelectedReservation, { kind: "cowork" }>;
    readonly passId: OrderId;
    readonly holderAccountId: CustomerAccountId;
    readonly db: WorkspaceDatabase["Service"]["db"];
    readonly forNewQuote?: true;
  }) {
    const { reservation, passId, holderAccountId, db, forNewQuote } = input;
    const date = yield* Schema.decodeEffect(plainDateStringSchema)(
      reservation.date
    ).pipe(Effect.mapError(() => new EntryPackUnavailableError({})));
    const entryPack = yield* loadEntryPackRedemption(
      db,
      { passId, holderAccountId, date },
      forNewQuote
    );
    const coveredTier =
      entryPack.tier === "reserved-desk-workstation"
        ? reservation.entryTier === "reserved-desk" &&
          Boolean(reservation.monitorOption)
        : entryPack.tier === reservation.entryTier;
    if (!coveredTier) return yield* new EntryPackUnavailableError({});

    return entryPack;
  }
);

type EntryPackQuoteInput = {
  readonly reservation: SelectedReservation;
  readonly passId: OrderId;
  readonly locale: Locale;
};

const buildEntryPackAdvertisement = (
  input: EntryPackQuoteInput,
  forNewQuote?: true
) =>
  Effect.succeed(input).pipe(
    Effect.tap(() => requireCoworkPassesRelease),
    Effect.bind("holder", () =>
      CurrentCustomerAccount.pipe(
        Effect.flatMap((account) => account.requireActive)
      )
    ),
    Effect.bind("cowork", ({ reservation }) =>
      reservation.kind === "cowork"
        ? Effect.succeed(reservation)
        : Effect.fail(new EntryPackUnavailableError({}))
    ),
    Effect.bind("entryPack", ({ holder, cowork, passId }) =>
      WorkspaceDatabase.pipe(
        Effect.flatMap(({ db }) =>
          resolveEntryPackBooking({
            reservation: cowork,
            passId,
            holderAccountId: holder.accountId,
            db,
            ...(forNewQuote && { forNewQuote }),
          })
        )
      )
    ),
    Effect.bind("quote", ({ cowork, entryPack }) =>
      buildCoworkReservationQuote(cowork, { entryPack })
    ),
    Effect.bind("advertisedPriceToken", ({ cowork, quote, locale }) =>
      buildAdvertisedPriceState({
        kind: cowork.kind,
        reservation: getCoworkAdvertisedPriceReservation(cowork),
        locale,
        quote,
      }).pipe(Effect.flatMap((state) => sealAdvertisedPriceState(state)))
    ),
    Effect.map(({ cowork, quote, advertisedPriceToken }) => ({
      kind: cowork.kind,
      quote,
      summary: getCoworkCheckoutSummary(cowork, quote),
      advertisedPriceToken,
    }))
  );

/** Quote the holder's selected pack and sign its funding into the advertisement. */
export const buildEntryPackBookingQuote = Effect.fn(
  "buildEntryPackBookingQuote"
)((input: EntryPackQuoteInput) => buildEntryPackAdvertisement(input, true));

/** Checkout reuses a matching hold before testing eligibility for a new claim. */
export const buildEntryPackHoldAdvertisement = Effect.fn(
  "buildEntryPackHoldAdvertisement"
)((input: EntryPackQuoteInput) => buildEntryPackAdvertisement(input));
