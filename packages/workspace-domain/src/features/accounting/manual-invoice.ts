import { Schema } from "effect";

export const invoiceIdSchema = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("InvoiceId"))
  .annotate({
    identifier: "InvoiceId",
    description:
      "Client-generated invoice id protected by database uniqueness.",
  });

export type InvoiceId = typeof invoiceIdSchema.Type;
