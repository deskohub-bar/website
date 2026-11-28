import { Schema } from "effect";

/**
 * The invoice number is interpolated into the Content-Disposition download
 * filename, so only the characters the numbering generator and legacy
 * numbers use are representable; quotes, separators, and control characters
 * can never break the header.
 */
export const invoiceNumberSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9/-]+$/)),
  Schema.brand("InvoiceNumber")
).annotate({
  identifier: "InvoiceNumber",
  description: "Deskohub invoice number.",
});

export type InvoiceNumber = typeof invoiceNumberSchema.Type;
