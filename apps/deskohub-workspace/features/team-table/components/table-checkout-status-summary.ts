import type { ReactNode } from "react";
import type { CheckoutStatusSummaryPresentation } from "@/features/checkout/checkout-status-summary-presentation";
import { getWorkspaceTableProductTitle } from "@/features/checkout/product-catalog.i18n";
import { type Locale, m } from "@/features/i18n";
import { formatReservationDisplayDateTimeRange } from "@/features/reservation/reservation-date";
import { formatMoney, type Money } from "@/shared/money/money";

export const getTableCheckoutStatusSummary = (
  summary: {
    readonly reservedFrom: Temporal.Instant;
    readonly reservedUntil: Temporal.Instant;
    readonly seats?: number;
    readonly price: Money;
  },
  locale: Locale,
  people?: ReactNode
): CheckoutStatusSummaryPresentation => {
  const reservationTitle = getWorkspaceTableProductTitle(locale);
  return {
    reservationTitle,
    rows: [
      {
        label: m.checkoutStatusSummaryReservationLabel({}, { locale }),
        value: reservationTitle,
      },
      {
        label: m.checkoutStatusSummaryDateLabel({}, { locale }),
        value: formatReservationDisplayDateTimeRange(
          summary.reservedFrom,
          summary.reservedUntil,
          locale
        ),
      },
      ...(summary.seats === undefined
        ? []
        : [
            {
              label: m.checkoutStatusSummarySeatsLabel({}, { locale }),
              value: summary.seats,
            },
          ]),
      ...(people
        ? [
            {
              label: m.checkoutStatusPeopleLabel({}, { locale }),
              value: people,
            },
          ]
        : []),
      {
        label: m.checkoutStatusSummaryPriceLabel({}, { locale }),
        value: formatMoney(summary.price, locale),
      },
    ],
  };
};
