import { describe, expect, test } from "bun:test";
import type { CustomerInvoice } from "@deskohub/workspace-customer-api";
import { sampleInvoices } from "../../customer-api/testing/sample-fixtures";
import {
  downloadableCreditNoteNumber,
  formatInvoiceTotal,
  invoiceRowOf,
  invoiceRowText,
} from "./invoice-list-model";

const locale = "en-US";
const invoices = sampleInvoices().map(({ invoice }) => invoice);
// The desk invoice says what it was for; the office one, issued by hand,
// doesn't.
const desk = invoices.find((invoice) => invoice.reservation !== undefined);
const manual = invoices.find((invoice) => invoice.reservation === undefined);
if (desk?.reservation === undefined || manual === undefined)
  throw new Error("the sample has described and plain invoices");
const subject = desk.reservation;

describe("invoice rows", () => {
  test("without what it was for, a row is plain: number, issue date, total", () => {
    const row = invoiceRowOf(manual);
    const text = invoiceRowText(row, locale);

    expect(text).toEqual({
      title: "2026-0341",
      when: "Oct 15, 2026",
      amount: "CZK\u00a07,260",
    });
  });

  test("described, a row leads with what it was for and the reservation's dates", () => {
    const row = invoiceRowOf(desk);
    const text = invoiceRowText(row, locale);

    expect(text).toEqual({
      title: "Open Space desk",
      when: "Nov 26, 2026",
      amount: "CZK\u00a0258.80",
    });
  });

  test("an office's row names its seats after the product", () => {
    const office: CustomerInvoice = {
      ...desk,
      reservation: { ...subject, productName: "Sample office", seats: 6 },
    };

    const { title } = invoiceRowText(invoiceRowOf(office), locale);

    expect(title).not.toBe("Sample office");
    expect(title).toContain("Sample office");
    expect(title).toContain("6");
  });

  test("the total keeps the digits it was issued with", () => {
    expect(
      formatInvoiceTotal({ amount: "258.80", currency: "CZK" }, locale)
    ).toContain("258.80");
    expect(
      formatInvoiceTotal({ amount: "280", currency: "CZK" }, locale)
    ).not.toContain(".");
  });
});

describe("downloadableCreditNoteNumber", () => {
  const cancellation = { correctiveDocumentNumber: "WS-OD-2026-000004" };

  test("a Workspace that doesn't serve the credit note leaves the cancelled row without it", () => {
    const row = invoiceRowOf({ ...desk, cancellation });

    expect(row.cancellation).toEqual(cancellation);
    expect(downloadableCreditNoteNumber(row)).toBeUndefined();
  });
});
