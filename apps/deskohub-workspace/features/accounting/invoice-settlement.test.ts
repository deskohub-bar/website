import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { formatCurrencyAmount } from "@deskohub/i18n/currency";
import { Schema } from "effect";
import { findWorkspaceCurrencyDefinition } from "@/shared/money/currencies";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { type InvoiceDocument, invoiceDocumentSchema } from "./invoice";
import {
  makeCoworkInvoiceDocument,
  makeTestManualInvoiceDocument,
} from "./invoice.test-utils";
import {
  formatInvoiceTotal,
  getInvoicePaymentStatus,
  getInvoiceSettlement,
  getInvoiceTotal,
  type InvoicePaymentStatus,
  InvoiceSettlement,
  type InvoiceTotal,
} from "./invoice-settlement";

const date = plainDateStringSchema.make;
const paidOn = { status: "paid", date: date("2026-08-20") } as const;

const reservation = makeCoworkInvoiceDocument("en-US");
const { payment } = reservation.quote;
const zeroTotalReservation = Schema.decodeUnknownSync(invoiceDocumentSchema)({
  ...reservation,
  quote: {
    ...reservation.quote,
    payment: {
      ...payment,
      expectedPrice: { ...payment.expectedPrice, value: 0 },
    },
  },
});
const due = makeTestManualInvoiceDocument("en-US", "450");
const variableSymbol = due.variableSymbol;

type Case = {
  readonly document: InvoiceDocument;
  readonly total: InvoiceTotal;
  readonly settlement: InvoiceSettlement;
  /** Status on the day before, on, and after 2026-09-01, the test due date. */
  readonly status: readonly [
    InvoicePaymentStatus,
    InvoicePaymentStatus,
    InvoicePaymentStatus,
  ];
};

const paidWithoutStatedDate = InvoiceSettlement.Paid({
  paidOn: null,
  variableSymbol: null,
});
const requested = InvoiceSettlement.PaymentRequested({
  dueDate: date("2026-09-01"),
  variableSymbol,
});
const nothingDue = InvoiceSettlement.NothingDue({
  statedDueDate: date("2026-09-01"),
});

const cases = {
  reservation: {
    document: reservation,
    total: { amount: "340.00", currency: "CZK" },
    settlement: paidWithoutStatedDate,
    status: ["paid", "paid", "paid"],
  },
  // Undecided zero-total policy: today's per-kind outcome.
  "zero-total reservation": {
    document: zeroTotalReservation,
    total: { amount: "0.00", currency: "CZK" },
    settlement: paidWithoutStatedDate,
    status: ["paid", "paid", "paid"],
  },
  "due manual": {
    document: due,
    total: { amount: "450", currency: "CZK" },
    settlement: requested,
    status: ["issued", "due", "overdue"],
  },
  "fractional due manual": {
    document: makeTestManualInvoiceDocument("cs-CZ", "1234.5"),
    total: { amount: "1234.5", currency: "CZK" },
    settlement: requested,
    status: ["issued", "due", "overdue"],
  },
  // Undecided zero-total policy: today's per-kind outcome.
  "zero-total due manual": {
    document: makeTestManualInvoiceDocument("en-US", "0"),
    total: { amount: "0", currency: "CZK" },
    settlement: nothingDue,
    status: ["issued", "issued", "issued"],
  },
  "negative-total due manual": {
    document: makeTestManualInvoiceDocument("en-US", "-100"),
    total: { amount: "-100", currency: "CZK" },
    settlement: nothingDue,
    status: ["issued", "issued", "issued"],
  },
  "paid manual": {
    document: makeTestManualInvoiceDocument("en-US", "450", paidOn),
    total: { amount: "450", currency: "CZK" },
    settlement: InvoiceSettlement.Paid({
      paidOn: date("2026-08-20"),
      variableSymbol,
    }),
    status: ["paid", "paid", "paid"],
  },
  "zero-total paid manual": {
    document: makeTestManualInvoiceDocument("en-US", "0", paidOn),
    total: { amount: "0", currency: "CZK" },
    settlement: InvoiceSettlement.Paid({
      paidOn: date("2026-08-20"),
      variableSymbol: null,
    }),
    status: ["paid", "paid", "paid"],
  },
  "EUR due manual": {
    document: { ...due, currency: "EUR", total: "0.01" },
    total: { amount: "0.01", currency: "EUR" },
    settlement: requested,
    status: ["issued", "due", "overdue"],
  },
} satisfies Record<string, Case>;

describe("invoice settlement", () => {
  test.each(Object.entries(cases))(
    "settles a %s invoice",
    (_name, { document, total, settlement, status }) => {
      expect(getInvoiceTotal(document)).toEqual(total);
      expect(getInvoiceSettlement(document)).toEqual(settlement);
      expect(
        ["2026-08-31", "2026-09-01", "2026-09-02"].map((today) =>
          getInvoicePaymentStatus(document, date(today))
        )
      ).toEqual(status);
    }
  );
});

describe("invoice total format", () => {
  test("formats the exact total for the locale", () => {
    expect(
      formatInvoiceTotal({ amount: "1234.50", currency: "CZK" }, "cs-CZ")
    ).toBe("1 234,50 Kč");
    expect(
      formatInvoiceTotal({ amount: "1234.50", currency: "CZK" }, "en-US")
    ).toBe("CZK 1,234.50");
  });

  test("keeps every digit of a total beyond double precision", () => {
    expect(
      formatInvoiceTotal(
        { amount: "123456789012345678.25", currency: "CZK" },
        "en-US"
      )
    ).toBe("CZK 123,456,789,012,345,678.25");
  });

  test("formats a negative zero total as the stored number reads", () => {
    for (const amount of ["-0", "-0.00"]) {
      for (const currency of ["CZK", "EUR"]) {
        for (const locale of ["cs-CZ", "en-US"] as const) {
          expect(formatInvoiceTotal({ amount, currency }, locale)).toBe(
            formatCurrencyAmount({
              amount: Number(amount),
              currency,
              locale,
              fractionDigits:
                findWorkspaceCurrencyDefinition(currency)?.exponent,
            })
          );
        }
      }
    }
  });
});
