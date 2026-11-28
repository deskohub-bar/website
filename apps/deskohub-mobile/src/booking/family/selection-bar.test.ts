import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import type {
  CustomerBookingQuote,
  CustomerTeamTableQuote,
  CustomerTeamTableSelection,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import { CustomerViewError } from "../../customer-api/customer-view-error";
import { m } from "../../i18n/messages";
import {
  BookingCatalogViewError,
  type BookingQueryViewError,
} from "../data/booking-query-error";
import {
  defaultCoworkDraft,
  selectCoworkDate,
} from "../selection/cowork-selection";
import {
  czk,
  sampleBookableDates,
  sampleOfferings,
} from "../testing/sample-booking-catalog";
import { openSpaceWithCoffee } from "../ui/testing/price-fixtures";
import { checkoutRequestOf, freshValue } from "./booking-family-view";
import { coworkBookingModel } from "./cowork-booking-model";
import { selectionBar } from "./selection-bar";

const from = { title: "Open Space", amount: czk(232), unit: "per day" };
const { selection, summary } = openSpaceWithCoffee;
const quote: CustomerBookingQuote = {
  family: "cowork",
  total: summary.total,
  regularPrice: czk(340),
  discount: czk(58),
  quotedAt: "2026-11-10T09:00:00.000Z",
  summary,
  advertisedPriceToken: "token",
};

const bar = (overrides: Partial<Parameters<typeof selectionBar>[0]> = {}) =>
  selectionBar({
    from,
    selection: Option.some(selection),
    quote: Option.none(),
    blocked: Option.none(),
    canContinue: false,
    locale: "en-US",
    ...overrides,
  });

describe("selectionBar", () => {
  test("uses the current Team Table quote for the sale, fees and checkout", () => {
    const table: CustomerTeamTableSelection = {
      family: "table",
      date: "2026-11-28",
      seats: 4,
      startTime: "23:30",
      endTime: "00:30",
    };
    const tableQuote: CustomerTeamTableQuote = {
      ...quote,
      family: "table",
      product: { kind: "table", seats: 4, durationMinutes: 60 },
      total: czk(280),
      regularPrice: czk(320),
      discount: czk(40),
      advertisedPriceToken: "table-quote",
      summary: {
        ...summary,
        total: czk(280),
        sections: [
          {
            key: "order",
            total: czk(280),
            items: [
              {
                key: "product:table:4:60",
                amount: czk(280),
                originalAmount: czk(320),
                baseAmount: czk(240),
                usageAmount: czk(80),
                discounts: [
                  {
                    amount: czk(40),
                    discount: {
                      id: "table-sale",
                      label: "Sale",
                      adjustment: { kind: "percentage", basisPoints: 1250 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const people = {
      contactAttends: false,
      invitees: [testEmailAddress("guest")],
    };
    const read = {
      kind: "loaded",
      value: tableQuote,
      refreshing: false,
    } as const;
    const checkout = checkoutRequestOf({
      locale: "en-US",
      selection: Option.some(table),
      blockers: [],
      quote: freshValue(read),
      people,
    });
    expect(Option.getOrThrow(checkout)).toMatchObject({
      selection: table,
      people,
      advertisedPriceToken: "table-quote",
    });

    const shown = bar({
      from: { title: "Team Table", amount: czk(320) },
      selection: Option.some(table),
      quote: Option.some(read),
      canContinue: Option.isSome(checkout),
    });
    expect(shown).toMatchObject({ action: "continue", disabled: false });
    const { price } = shown.summary;
    expect(price).toMatchObject({ kind: "quoted", was: czk(320) });
    if (price.kind !== "quoted") throw new Error("No Team Table quote");
    expect(
      price.breakdown.lines.map(({ _tag, amount }) => [_tag, amount])
    ).toEqual([
      ["Charge", czk(240)],
      ["Charge", czk(80)],
      ["Reduction", czk(40)],
    ]);
  });

  test("before a date: the from-price, Continue off with the reason", () => {
    const shown = bar({
      selection: Option.none(),
      blocked: Option.some("reason"),
    });

    expect(shown.summary.title).toBe(from.title);
    expect(shown.summary.price).toEqual({
      kind: "from",
      amount: from.amount,
      unit: from.unit,
    });
    expect(shown).toMatchObject({
      action: "continue",
      disabled: true,
      reason: "reason",
    });
  });

  test("before a date: keeps the from-price when there is no unit", () => {
    const shown = bar({
      from: { title: from.title, amount: from.amount },
      selection: Option.none(),
    });

    expect(shown.summary.price).toStrictEqual({
      kind: "from",
      amount: from.amount,
    });
  });

  test("does not show a from-price when the offering has no minimum", () => {
    const shown = bar({
      from: { title: "Team Table" },
      selection: Option.none(),
    });

    expect(shown.summary).toEqual({
      title: "Team Table",
      price: { kind: "none" },
    });
    expect(shown.disabled).toBe(true);
  });

  test("while quoting: the selection and Updating price", () => {
    const shown = bar({ quote: Option.some({ kind: "loading" }) });

    expect(shown.summary.price).toEqual({ kind: "updating" });
    expect(shown.summary.title).not.toBe(from.title);
    expect(shown.disabled).toBe(true);
  });

  test("quoted: the breakdown with the struck regular price, Continue on", () => {
    const shown = bar({
      quote: Option.some({ kind: "loaded", value: quote, refreshing: false }),
      canContinue: true,
    });

    expect(shown.summary.price).toMatchObject({
      kind: "quoted",
      was: czk(340),
    });
    expect(shown).toMatchObject({ action: "continue", disabled: false });
    expect(shown.reason).toBeUndefined();
  });

  test("a covered Open Space booking shows the cutoff when the selected day closes", () => {
    const locale = "en-US";
    const date = "2026-11-26";
    const { offerings } = sampleOfferings(locale, date);
    const bookableDates = sampleBookableDates(date, "cowork");
    const draft = selectCoworkDate(defaultCoworkDraft(offerings), date);
    const free = Option.some({
      from: date,
      to: date,
      unavailableDates: [],
      reservedDeskWorkstationRequiredDates: [],
      unavailableCoworkTiers: [],
      meetingRoomUnavailable: false,
      officeUnavailable: false,
      unavailableMonitorOptions: [],
      notices: [],
    });
    const readyNotice = m.booking_pass_unlimited_covers({}, { locale });
    const cutoff = m.booking_cowork_open_space_closed_today({}, { locale });
    const at = (instant: string) => {
      const model = coworkBookingModel({
        draft,
        now: new Date(instant),
        offerings,
        bookableDates,
        availability: {
          range: free,
          selection: free,
          workstationRequirement: Option.none(),
        },
      });
      const closed = model.enablement.blockers.some(
        (blocker) => blocker._tag === "OpenSpaceClosedToday"
      );
      return bar({
        selection: model.selection,
        quote: Option.some({ kind: "loaded", value: quote, refreshing: false }),
        blocked: closed ? Option.some(cutoff) : Option.none(),
        canContinue: Option.isSome(model.quotable),
        readyNotice,
      });
    };
    expect(at("2026-11-26T15:59:59Z")).toMatchObject({
      action: "continue",
      disabled: false,
      reason: readyNotice,
    });
    expect(at("2026-11-26T16:00:00Z")).toMatchObject({
      action: "continue",
      disabled: true,
      reason: cutoff,
    });
  });

  test("a failed quote: no price, Try again when retrying can help", () => {
    const failed = (error: BookingQueryViewError) =>
      bar({
        quote: Option.some({
          kind: "failed",
          error,
          value: Option.none(),
          retrying: false,
        }),
      });

    expect(failed(CustomerViewError.Unavailable())).toMatchObject({
      summary: { price: { kind: "none" } },
      action: "retry",
      disabled: false,
    });
    expect(
      failed(BookingCatalogViewError.SelectionInvalid({ field: undefined }))
    ).toMatchObject({ action: "continue", disabled: true });
  });

  test("names the product by the catalog's name before and after a date", () => {
    const catalogName = "Catalog desk name";
    const named = { ...from, title: catalogName };

    const dated = selectionBar({
      from: named,
      selection: Option.some(selection),
      quote: Option.some({ kind: "loading" }),
      blocked: Option.none(),
      canContinue: false,
      locale: "en-US",
    });
    const quoted = selectionBar({
      from: named,
      selection: Option.some(selection),
      quote: Option.some({ kind: "loaded", value: quote, refreshing: false }),
      blocked: Option.none(),
      canContinue: true,
      locale: "en-US",
    });

    expect(dated.summary.detail?.startsWith(catalogName)).toBe(true);
    expect(quoted.summary.detail?.startsWith(catalogName)).toBe(true);
    if (quoted.summary.price.kind !== "quoted") throw new Error("not quoted");
    const { breakdown, describeLine } = quoted.summary.price;
    const product = breakdown.lines.find(
      (line) => line._tag === "Charge" && line.subject._tag === "Product"
    );
    if (product === undefined) throw new Error("no product line");
    expect(describeLine(product).label).toBe(catalogName);
  });
});
