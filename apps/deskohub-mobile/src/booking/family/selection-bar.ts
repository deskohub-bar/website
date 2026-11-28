import type {
  CustomerBookingQuote,
  Money,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import type { AppLocale } from "../../i18n/app-locale";
import type { BookingSelection } from "../selection/booking-selection";
import type { CoworkOvernightStay } from "../selection/cowork-selection";
import type { BookingBarSummary } from "../ui/booking-bar";
import { bookingSummaryOf, quotedBarSummary } from "../ui/booking-summary";
import {
  type BookingRead,
  isRetryableBookingQueryError,
} from "./booking-family-view";

/** What a selection screen's booking bar shows and does. */
export interface SelectionBar {
  readonly summary: BookingBarSummary;
  /**
   * `continue` opens checkout once it isn't `disabled`; `retry` asks for the
   * price again after the quote failed in a way retrying can help.
   */
  readonly action: "continue" | "retry";
  readonly disabled: boolean;
  /** A blocker or a notice about the booking, shown under Continue. */
  readonly reason?: string;
}

/**
 * The booking bar of a selection screen (Choose step): the product's
 * from-price and why Continue is off until the selection is complete; then
 * what and when with the quoted total, "Updating price…" while it is
 * quoted, and Try again when the quote failed in a way retrying can help.
 */
export const selectionBar = ({
  from,
  selection,
  quote,
  blocked,
  readyNotice,
  canContinue,
  locale,
}: {
  /**
   * Before the selection is complete: the product's name and price. The
   * name is the catalog's, and names the product in the summaries after.
   */
  readonly from: {
    readonly title: string;
    /** The from-price, when the catalog offers one. */
    readonly amount?: Money;
    /** Such as "per day". */
    readonly unit?: string;
    /**
     * A Reserved Desk's overnight stay times, which an overnight selection's
     * summary shows.
     */
    readonly overnightStay?: CoworkOvernightStay;
  };
  /** None until the selection is complete. */
  readonly selection: Option.Option<BookingSelection>;
  /** None while there is nothing to quote. */
  readonly quote: Option.Option<
    BookingRead<Pick<CustomerBookingQuote, "summary" | "regularPrice">>
  >;
  /** Why the selection can't continue, worded; none when nothing blocks it. */
  readonly blocked: Option.Option<string>;
  /** Information to show once the booking can continue. */
  readonly readyNotice?: string;
  readonly canContinue: boolean;
  readonly locale: AppLocale;
}): SelectionBar => {
  const reason = Option.getOrUndefined(blocked);
  if (Option.isNone(selection)) {
    return {
      summary: {
        title: from.title,
        price:
          from.amount === undefined
            ? { kind: "none" }
            : {
                kind: "from",
                amount: from.amount,
                ...(from.unit !== undefined && { unit: from.unit }),
              },
      },
      action: "continue",
      disabled: true,
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const chosen = selection.value;
  const product = {
    name: from.title,
    ...(from.overnightStay === undefined
      ? {}
      : { overnightStay: from.overnightStay }),
  };
  const read = Option.getOrUndefined(quote);
  const unpriced = (price: BookingBarSummary["price"]): BookingBarSummary => ({
    ...bookingSummaryOf(chosen, locale, product),
    price,
  });
  if (read?.kind === "failed") {
    const retry = isRetryableBookingQueryError(read.error);
    return {
      summary: unpriced({ kind: read.retrying ? "updating" : "none" }),
      action: retry ? "retry" : "continue",
      disabled: retry ? read.retrying : true,
      ...(retry || reason === undefined ? {} : { reason }),
    };
  }
  const continueReason = reason ?? (canContinue ? readyNotice : undefined);
  return {
    summary:
      read?.kind === "loaded" && !read.refreshing
        ? quotedBarSummary(chosen, read.value, locale, product)
        : unpriced({ kind: read === undefined ? "none" : "updating" }),
    action: "continue",
    disabled: !canContinue,
    ...(continueReason === undefined ? {} : { reason: continueReason }),
  };
};
