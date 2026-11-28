import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Schema } from "effect";
import type { PreparedCustomerQuote } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import {
  buildCoworkReservationQuote,
  type CoworkReservationQuoteOrder,
} from "@/features/checkout/checkout-quote.test-utils";
import { buildOfficeReservationQuote } from "@/features/checkout/reservation-quote-office";
import { buildTableReservationQuote } from "@/features/checkout/reservation-quote-table";
import { orderIdSchema } from "@/features/order";
import { normalizedCoworkReservationOrderSchema } from "@/features/reservation/cowork-reservation";
import { normalizedOfficeReservationOrderSchema } from "@/features/reservation/office-reservation";
import { tableReservationOrderSchema } from "@/features/reservation/table-reservation";
import { currencyCZK } from "@/shared/money/currencies";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { makeAccountingDocumentSnapshot } from "./accounting-document-snapshot";
import {
  decodeInvoiceDocument,
  formatInvoiceNumber,
  getInvoiceNumberingYear,
  invoiceDocumentSchema,
  isLineItemInvoiceDocument,
  makeInvoiceDocument,
  makePassPurchaseInvoiceDocument,
} from "./invoice";
import { makeTestManualInvoiceDocument } from "./invoice.test-utils";
import { getInvoiceStatedLines } from "./invoice-presentation";

const coworkOrder = {
  entryTier: "basic",
  coffee: true,
} satisfies CoworkReservationQuoteOrder;

const prepared: PreparedCustomerQuote = {
  kind: "cowork",
  reservation: Schema.decodeUnknownSync(normalizedCoworkReservationOrderSchema)(
    {
      kind: "cowork",
      ...coworkOrder,
      date: "2099-01-01",
      name: "Original Buyer",
      email: testEmailAddress("synthetic"),
      phone: "+420 700 000 000",
    }
  ),
  quote: buildCoworkReservationQuote(coworkOrder),
};

const source = makeAccountingDocumentSnapshot({
  workspaceReservationId: "reservation-id",
  dotyposReservationId: "dotypos-reservation-id",
  dotyposCustomerId: "dotypos-customer-id",
  locale: "en-US",
  prepared,
});

const paidAt = Temporal.Instant.from("2026-08-10T12:30:00Z");
const fulfilledAt = Temporal.Instant.from("2026-08-11T08:00:00Z");
const issuedAt = Temporal.Instant.from("2026-08-12T12:34:56.789Z");

const personalInvoiceBuyer = {
  kind: "person" as const,
  legalName: "Original Buyer",
  address: {
    line1: "Synthetic 1",
    city: "Praha",
    postalCode: "100 00",
    country: "CZ",
  },
};

describe("invoice", () => {
  test("freezes both Team Table charges and the precise booked interval", async () => {
    const reservation = Schema.decodeUnknownSync(
      tableReservationOrderSchema("CZ")
    )({
      kind: "table",
      startsAt: "2026-08-11T09:15:00Z",
      endsAt: "2026-08-11T10:00:00Z",
      seats: 4,
      name: "Table Buyer",
      email: testEmailAddress("table-buyer"),
      phone: "+420 700 000 000",
    });
    const tableSource = makeAccountingDocumentSnapshot({
      workspaceReservationId: "table-reservation-id",
      dotyposReservationId: "dotypos-table-reservation-id",
      dotyposCustomerId: "dotypos-customer-id",
      locale: "en-US",
      prepared: {
        kind: "table",
        reservation,
        quote: Effect.runSync(buildTableReservationQuote(reservation)),
      },
    });
    const document = makeInvoiceDocument({
      source: tableSource,
      buyer: personalInvoiceBuyer,
      paymentAttemptId: "table-payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 2 }),
      issuedAt,
      fulfilledAt,
      paidAt,
    });

    expect(document.reservation).toEqual(tableSource.reservation);
    expect(getInvoiceStatedLines(document)).toEqual([
      { description: "Team Table base charge · 4 seats", amount: "240.00" },
      { description: "Team Table time charge · 45 min", amount: "60.00" },
    ]);
    await expect(
      Effect.runPromise(decodeInvoiceDocument(document))
    ).resolves.toEqual(document);
  });

  test("uses the paid coffee price for a pass bought before catalog repricing", () => {
    const product = { kind: "unlimited", tier: "open-space" } as const;
    const document = makePassPurchaseInvoiceDocument({
      source: {
        orderId: orderIdSchema.make("019ac0e6-f461-77de-9492-26af32cc74a3"),
        dotyposCustomerId: source.dotyposCustomerId,
        locale: source.locale,
        supplier: source.supplier,
        buyer: personalInvoiceBuyer,
        billing: { purpose: "personal", invoice: "none" },
        delivery: { email: testEmailAddress("pass-buyer") },
        serviceDate: plainDateStringSchema.make("2026-08-10"),
        product,
        coffeeAmountMinor: 53_000,
        quote: {
          product,
          discountableSubtotal: currencyCZK(350_000),
          discountedSubtotal: currencyCZK(350_000),
          totalDiscount: currencyCZK(0),
          discounts: [],
        },
      },
      buyer: personalInvoiceBuyer,
      paymentAttemptId: "payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 42 }),
      issuedAt,
      paidAt,
    });

    expect(document.lines.map(({ price }) => price)).toEqual([
      "3500.00",
      "530.00",
    ]);
    expect(document.total).toBe("4030.00");
  });

  test("formats positive annual sequences without arbitrary upper bounds", () => {
    expect(formatInvoiceNumber({ year: 2026, sequence: 1 })).toBe(
      "WS-FV-2026-000001"
    );
    expect(formatInvoiceNumber({ year: 10_000, sequence: 1_000_000 })).toBe(
      "WS-FV-10000-1000000"
    );
    expect(() => formatInvoiceNumber({ year: 2026, sequence: 0 })).toThrow(
      RangeError
    );
  });

  test("uses the Prague calendar year at the UTC New Year boundary", () => {
    expect(
      getInvoiceNumberingYear(Temporal.Instant.from("2026-12-31T22:59:59.999Z"))
    ).toBe(2026);
    expect(
      getInvoiceNumberingYear(Temporal.Instant.from("2026-12-31T23:00:00Z"))
    ).toBe(2027);
  });

  test("freezes an explicit invoice buyer without changing the source", () => {
    const document = makeInvoiceDocument({
      source,
      buyer: {
        kind: "business",
        legalName: "Invoice Buyer s.r.o.",
        companyId: "12345678",
        vatId: "CZ12345678",
        address: {
          line1: "Synthetic 1",
          city: "Praha",
          postalCode: "100 00",
          country: "CZ",
        },
      },
      paymentAttemptId: "payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 42 }),
      issuedAt,
      paidAt,
      fulfilledAt,
    });

    expect(document).toMatchObject({
      workspaceReservationId: "reservation-id",
      paymentAttemptId: "payment-attempt-id",
      invoiceNumber: "WS-FV-2026-000042",
      issuedAt: "2026-08-12T12:34:56.789Z",
      paidAt: "2026-08-10T12:30:00.000Z",
      fulfilledAt: "2026-08-11T08:00:00.000Z",
      supplier: source.supplier,
      reservation: source.reservation,
      quote: source.quote,
      buyer: {
        kind: "business",
        legalName: "Invoice Buyer s.r.o.",
      },
      provenance: {
        system: "deskohub-workspace",
        generatedAt: "2026-08-12T12:34:56.789Z",
        source: "reservation-request",
      },
    });
    expect(document).not.toHaveProperty("schemaVersion");
    expect(document).not.toHaveProperty("billing");
    expect(document).not.toHaveProperty("delivery");
    expect(source.buyer).toEqual({
      kind: "person",
      legalName: "Original Buyer",
    });
  });

  test("decodes invoices issued before rendering facts were added", async () => {
    const document = makeInvoiceDocument({
      source,
      buyer: personalInvoiceBuyer,
      paymentAttemptId: "payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 1 }),
      issuedAt,
      fulfilledAt,
      paidAt,
    });
    if (isLineItemInvoiceDocument(document)) {
      throw new Error("Expected a reservation invoice");
    }
    const {
      fulfilledAt: _fulfilledAt,
      paidAt: _paidAt,
      supplier,
      ...identity
    } = document;
    const { commercialRegister: _commercialRegister, ...legacySupplier } =
      supplier;
    const legacyDocument = { ...identity, supplier: legacySupplier };

    await expect(
      Effect.runPromise(decodeInvoiceDocument(legacyDocument))
    ).resolves.toEqual(legacyDocument);
  });

  test("decodes legacy reservation invoices without provenance", async () => {
    const document = makeInvoiceDocument({
      source,
      buyer: personalInvoiceBuyer,
      paymentAttemptId: "payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 1 }),
      issuedAt,
      fulfilledAt,
      paidAt,
    });
    const { provenance: _provenance, ...legacyDocument } = document;

    await expect(
      Effect.runPromise(decodeInvoiceDocument(legacyDocument))
    ).resolves.toEqual(legacyDocument);
  });

  test("decodes manual invoices issued with the original due-date shape", async () => {
    const document = makeTestManualInvoiceDocument("en-US");

    expect(document).toHaveProperty("dueDate", "2026-09-01");
    await expect(
      Effect.runPromise(decodeInvoiceDocument(document))
    ).resolves.toEqual(document);
  });

  test("decodes invoices issued before stricter billing input validation", async () => {
    const document = makeInvoiceDocument({
      source,
      buyer: personalInvoiceBuyer,
      paymentAttemptId: "payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 1 }),
      issuedAt,
      fulfilledAt,
      paidAt,
    });
    const legacyDocument = {
      ...document,
      buyer: {
        ...document.buyer,
        address: {
          ...document.buyer.address,
          postalCode: "legacy-postcode",
          country: "Czech Republic",
        },
      },
    };

    await expect(
      Effect.runPromise(decodeInvoiceDocument(legacyDocument))
    ).resolves.toEqual(legacyDocument);
  });

  test("rejects issued invoices without complete buyer billing details", async () => {
    const document = makeInvoiceDocument({
      source,
      buyer: personalInvoiceBuyer,
      paymentAttemptId: "payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 1 }),
      issuedAt,
      fulfilledAt,
      paidAt,
    });
    const { address: _address, ...nameOnlyBuyer } = document.buyer;

    await expect(
      Effect.runPromise(
        decodeInvoiceDocument({ ...document, buyer: nameOnlyBuyer })
      )
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        decodeInvoiceDocument({
          ...document,
          buyer: {
            ...document.buyer,
            address: { ...document.buyer.address, line1: "   " },
          },
        })
      )
    ).rejects.toBeDefined();
  });

  test("issues from an office reservation snapshot", async () => {
    const reservation = normalizedOfficeReservationOrderSchema.make({
      kind: "office",
      startsOn: "2099-06-20",
      endsOn: "2099-06-21",
      seats: 3,
      name: "Office Buyer",
      email: testEmailAddress("office-buyer"),
      phone: "+420 700 000 000",
    });
    const officeSource = makeAccountingDocumentSnapshot({
      workspaceReservationId: "office-reservation-id",
      dotyposReservationId: "dotypos-office-reservation-id",
      dotyposCustomerId: "dotypos-customer-id",
      locale: "en-US",
      prepared: {
        kind: "office",
        reservation,
        quote: Effect.runSync(buildOfficeReservationQuote(reservation)),
      },
    });
    const document = makeInvoiceDocument({
      source: officeSource,
      buyer: personalInvoiceBuyer,
      paymentAttemptId: "office-payment-attempt-id",
      invoiceNumber: formatInvoiceNumber({ year: 2026, sequence: 2 }),
      issuedAt,
      fulfilledAt,
      paidAt,
    });

    expect(document).toMatchObject({
      reservation: {
        kind: "office",
        startsOn: "2099-06-20",
        endsOn: "2099-06-21",
        seats: 3,
      },
      quote: officeSource.quote,
    });
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(invoiceDocumentSchema, {
          onExcessProperty: "error",
        })(document)
      )
    ).resolves.toEqual(document);
  });
});
