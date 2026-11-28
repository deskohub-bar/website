import {
  type InvoiceNumber,
  invoiceNumberSchema,
} from "@deskohub/workspace-domain/features/accounting/invoice";

export {
  type InvoiceNumber,
  invoiceNumberSchema,
} from "@deskohub/workspace-domain/features/accounting/invoice";

import { Schema } from "effect";
import { m } from "@/features/i18n";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { withPassPurchaseCoffee } from "@/features/passes/pass-purchase-quote";
import { workspaceCurrencyCodeSchema } from "@/shared/money/currencies";
import { moneyToDecimalString, moneyWithValue } from "@/shared/money/money";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  instantStringSchema,
  plainDateStringSchema,
  temporalInstantToIsoString,
  temporalInstantToPlainDate,
} from "@/shared/utils/temporal";
import {
  type AccountingDocumentSnapshot,
  accountingDocumentIdentitySchema,
  coworkAccountingDocumentSnapshotSchema,
  meetingRoomAccountingDocumentSnapshotSchema,
  officeAccountingDocumentSnapshotSchema,
  type PassPurchaseAccountingSnapshot,
  passPurchaseAccountingSnapshotSchema,
  tableAccountingDocumentSnapshotSchema,
  workspaceAccountingSupplier,
} from "./accounting-document-snapshot";
import type { InvoiceBuyer } from "./billing-identity";
import {
  type InvoiceVariableSymbol,
  invoiceIdSchema,
  invoiceVariableSymbolSchema,
  manualInvoiceLineSchema,
  manualInvoiceProvenanceSchema,
  type NormalizedManualInvoiceInput,
} from "./manual-invoice";

export {
  type InvoiceBuyer,
  invoiceBuyerSchema,
} from "./billing-identity";

const storedInvoiceBillingTextSchema = Schema.Trim.check(Schema.isNonEmpty());
const storedInvoiceBuyerAddressSchema = Schema.Struct({
  line1: storedInvoiceBillingTextSchema,
  line2: Schema.optionalKey(storedInvoiceBillingTextSchema),
  city: storedInvoiceBillingTextSchema,
  postalCode: storedInvoiceBillingTextSchema,
  country: storedInvoiceBillingTextSchema,
});
/** The buyer an issued accounting document stores. */
export const storedInvoiceBuyerSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    legalName: storedInvoiceBillingTextSchema,
    address: storedInvoiceBuyerAddressSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("business"),
    legalName: storedInvoiceBillingTextSchema,
    companyId: storedInvoiceBillingTextSchema.pipe(
      Schema.brand("CompanyRegistrationId")
    ),
    vatId: Schema.optionalKey(
      storedInvoiceBillingTextSchema.pipe(Schema.brand("VatRegistrationId"))
    ),
    address: storedInvoiceBuyerAddressSchema,
  }),
]);

const invoiceGenerationProvenanceSchema = Schema.Struct({
  system: Schema.Literal("deskohub-workspace"),
  generatedAt: instantStringSchema,
});

/** The supplier an issued accounting document stores. */
export const invoiceSupplierSchema = Schema.Struct({
  ...accountingDocumentIdentitySchema.fields.supplier.fields,
  commercialRegister: Schema.optional(
    Schema.Struct({
      court: Schema.NonEmptyString,
      section: Schema.NonEmptyString,
      file: Schema.NonEmptyString,
    })
  ),
});

const invoiceIdentitySchema = Schema.Struct({
  ...accountingDocumentIdentitySchema.fields,
  buyer: storedInvoiceBuyerSchema,
  supplier: invoiceSupplierSchema,
  paymentAttemptId: Schema.NonEmptyString,
  invoiceNumber: invoiceNumberSchema,
  issuedAt: instantStringSchema,
  fulfilledAt: Schema.optional(instantStringSchema),
  paidAt: Schema.optional(instantStringSchema),
  provenance: Schema.optionalKey(
    Schema.Struct({
      ...invoiceGenerationProvenanceSchema.fields,
      source: Schema.Literals(["reservation-request", "post-order-link"]),
    })
  ),
});

const coworkInvoiceDocumentSchema = Schema.Struct({
  ...invoiceIdentitySchema.fields,
  reservation: coworkAccountingDocumentSnapshotSchema.fields.reservation,
  quote: coworkAccountingDocumentSnapshotSchema.fields.quote,
});

const meetingRoomInvoiceDocumentSchema = Schema.Struct({
  ...invoiceIdentitySchema.fields,
  reservation: meetingRoomAccountingDocumentSnapshotSchema.fields.reservation,
  quote: meetingRoomAccountingDocumentSnapshotSchema.fields.quote,
});

const officeInvoiceDocumentSchema = Schema.Struct({
  ...invoiceIdentitySchema.fields,
  reservation: officeAccountingDocumentSnapshotSchema.fields.reservation,
  quote: officeAccountingDocumentSnapshotSchema.fields.quote,
});

const tableInvoiceDocumentSchema = Schema.Struct({
  ...invoiceIdentitySchema.fields,
  reservation: tableAccountingDocumentSnapshotSchema.fields.reservation,
  quote: tableAccountingDocumentSnapshotSchema.fields.quote,
});

const manualInvoiceDocumentIdentitySchema = Schema.Struct({
  documentKind: Schema.Literal("manual"),
  invoiceId: invoiceIdSchema,
  dotyposCustomerId: accountingDocumentIdentitySchema.fields.dotyposCustomerId,
  locale: accountingDocumentIdentitySchema.fields.locale,
  supplier: invoiceIdentitySchema.fields.supplier,
  buyer: storedInvoiceBuyerSchema,
  delivery: Schema.Struct({ email: Schema.NonEmptyString }),
  invoiceNumber: invoiceNumberSchema,
  issuedAt: instantStringSchema,
  serviceDate: plainDateStringSchema,
  currency: workspaceCurrencyCodeSchema,
  variableSymbol: invoiceVariableSymbolSchema,
  lines: Schema.Array(manualInvoiceLineSchema).check(Schema.isMinLength(1)),
  total: Schema.String,
  provenance: Schema.Struct({
    ...manualInvoiceProvenanceSchema.fields,
    ...invoiceGenerationProvenanceSchema.fields,
  }),
});

const manualInvoiceDocumentSchema = Schema.Union([
  Schema.Struct({
    ...manualInvoiceDocumentIdentitySchema.fields,
    payment: Schema.Struct({
      status: Schema.Literal("paid"),
      date: plainDateStringSchema,
    }),
  }),
  Schema.Struct({
    ...manualInvoiceDocumentIdentitySchema.fields,
    dueDate: plainDateStringSchema,
  }),
]);
export type ManualInvoiceDocument = typeof manualInvoiceDocumentSchema.Type;

const entryPackInvoiceDocumentSchema = Schema.Struct({
  documentKind: Schema.Literal("pass-purchase"),
  orderId: passPurchaseAccountingSnapshotSchema.fields.orderId,
  dotyposCustomerId: invoiceIdentitySchema.fields.dotyposCustomerId,
  locale: invoiceIdentitySchema.fields.locale,
  supplier: invoiceSupplierSchema,
  buyer: storedInvoiceBuyerSchema,
  delivery: passPurchaseAccountingSnapshotSchema.fields.delivery,
  paymentAttemptId: invoiceIdentitySchema.fields.paymentAttemptId,
  invoiceNumber: invoiceNumberSchema,
  issuedAt: instantStringSchema,
  serviceDate: plainDateStringSchema,
  payment: Schema.Struct({
    status: Schema.Literal("paid"),
    date: plainDateStringSchema,
  }),
  currency: workspaceCurrencyCodeSchema,
  variableSymbol: invoiceVariableSymbolSchema,
  lines: manualInvoiceDocumentIdentitySchema.fields.lines,
  total: Schema.String,
  provenance: invoiceGenerationProvenanceSchema,
});

export type EntryPackInvoiceDocument =
  typeof entryPackInvoiceDocumentSchema.Type;

export const invoiceDocumentSchema = Schema.Union([
  coworkInvoiceDocumentSchema,
  meetingRoomInvoiceDocumentSchema,
  officeInvoiceDocumentSchema,
  tableInvoiceDocumentSchema,
  manualInvoiceDocumentSchema,
  entryPackInvoiceDocumentSchema,
]).annotate({
  identifier: "InvoiceDocument",
  description:
    "Immutable facts of an issued invoice, independent of mutable customer data.",
});

export type InvoiceDocument = typeof invoiceDocumentSchema.Type;

export const isManualInvoiceDocument = (
  document: InvoiceDocument
): document is ManualInvoiceDocument =>
  "documentKind" in document && document.documentKind === "manual";

export const isEntryPackInvoiceDocument = (
  document: InvoiceDocument
): document is EntryPackInvoiceDocument =>
  "documentKind" in document && document.documentKind === "pass-purchase";

export type ReservationInvoiceDocument = Exclude<
  InvoiceDocument,
  ManualInvoiceDocument | EntryPackInvoiceDocument
>;

export const isLineItemInvoiceDocument = (
  document: InvoiceDocument
): document is ManualInvoiceDocument | EntryPackInvoiceDocument =>
  "documentKind" in document;

export const getInvoiceEmailReference = (document: InvoiceDocument) => {
  if (isManualInvoiceDocument(document)) return { source: "manual" } as const;
  if (isEntryPackInvoiceDocument(document)) {
    return { source: "pass-purchase", orderId: document.orderId } as const;
  }
  return {
    source: "reservation",
    orderId: document.workspaceReservationId,
  } as const;
};

const decodeInvoiceNumber = Schema.decodeUnknownSync(invoiceNumberSchema);
export const decodeInvoiceDocument = Schema.decodeUnknownEffect(
  invoiceDocumentSchema,
  { onExcessProperty: "error" }
);

export const getInvoiceNumberingYear = (issuedAt: Temporal.Instant) =>
  issuedAt.toZonedDateTimeISO(workspaceSiteConstants.location.timeZone).year;

export const formatInvoiceNumber = (input: {
  readonly year: number;
  readonly sequence: number;
}): InvoiceNumber => {
  if (
    !Number.isInteger(input.year) ||
    !Number.isInteger(input.sequence) ||
    input.sequence < 1
  ) {
    throw new RangeError("Invoice number components are outside their range.");
  }

  return decodeInvoiceNumber(
    `WS-FV-${input.year}-${input.sequence.toString().padStart(6, "0")}`
  );
};

export const makeInvoiceDocument = (input: {
  readonly source: AccountingDocumentSnapshot;
  readonly buyer: InvoiceBuyer;
  readonly paymentAttemptId: string;
  readonly invoiceNumber: InvoiceNumber;
  readonly issuedAt: Temporal.Instant;
  readonly fulfilledAt: Temporal.Instant;
  readonly paidAt: Temporal.Instant;
  readonly provenance?: {
    readonly source: "reservation-request" | "post-order-link";
  };
}): InvoiceDocument => {
  const generatedAt = instantStringSchema.make(
    temporalInstantToIsoString(input.issuedAt)
  );
  return invoiceDocumentSchema.make({
    ...input.source,
    supplier: {
      ...input.source.supplier,
      commercialRegister: workspaceSiteConstants.company.commercialRegister,
    },
    buyer: input.buyer,
    paymentAttemptId: input.paymentAttemptId,
    invoiceNumber: input.invoiceNumber,
    issuedAt: generatedAt,
    fulfilledAt: instantStringSchema.make(
      temporalInstantToIsoString(input.fulfilledAt)
    ),
    paidAt: instantStringSchema.make(temporalInstantToIsoString(input.paidAt)),
    provenance: {
      ...getInvoiceGenerationProvenance(generatedAt),
      ...(input.provenance ?? { source: "reservation-request" }),
    },
  });
};

export const getInvoiceVariableSymbol = (
  invoiceNumber: InvoiceNumber
): InvoiceVariableSymbol =>
  invoiceVariableSymbolSchema.make(invoiceNumber.replace(/\D/g, "").slice(-10));

export const makeManualInvoiceDocument = (input: {
  readonly normalized: NormalizedManualInvoiceInput;
  readonly invoiceNumber: InvoiceNumber;
  readonly issuedAt: Temporal.Instant;
}): ManualInvoiceDocument => {
  const { normalized } = input;
  const generatedAt = instantStringSchema.make(
    temporalInstantToIsoString(input.issuedAt)
  );
  return manualInvoiceDocumentSchema.make({
    documentKind: "manual",
    invoiceId: normalized.invoiceId,
    dotyposCustomerId: normalized.dotyposCustomerId,
    locale: normalized.locale,
    supplier: {
      ...workspaceAccountingSupplier,
      commercialRegister: workspaceSiteConstants.company.commercialRegister,
    },
    buyer: normalized.buyer,
    delivery: { email: normalized.deliveryEmail },
    invoiceNumber: input.invoiceNumber,
    issuedAt: generatedAt,
    serviceDate: normalized.serviceDate,
    ...(normalized.payment.status === "paid"
      ? { payment: normalized.payment }
      : { dueDate: normalized.payment.date }),
    currency: normalized.currency,
    variableSymbol:
      normalized.variableSymbol ??
      getInvoiceVariableSymbol(input.invoiceNumber),
    lines: normalized.lines,
    total: normalized.total,
    provenance: {
      ...normalized.provenance,
      ...getInvoiceGenerationProvenance(generatedAt),
    },
  });
};

export const makePassPurchaseInvoiceDocument = (input: {
  readonly source: PassPurchaseAccountingSnapshot;
  readonly buyer: InvoiceBuyer;
  readonly paymentAttemptId: string;
  readonly invoiceNumber: InvoiceNumber;
  readonly issuedAt: Temporal.Instant;
  readonly paidAt: Temporal.Instant;
}): EntryPackInvoiceDocument => {
  const { source, invoiceNumber } = input;
  const { locale, quote, product, coffeeAmountMinor } = source;
  const issuedAt = instantStringSchema.make(
    temporalInstantToIsoString(input.issuedAt)
  );
  const description = [
    product.kind === "entry-pack"
      ? m.passEntryPack({}, { locale })
      : m.passUnlimited({}, { locale }),
    getPassTierName(product.tier, locale),
    ...(product.kind === "entry-pack"
      ? [m.passEntryCount({ count: product.size }, { locale })]
      : []),
  ].join(" · ");
  return entryPackInvoiceDocumentSchema.make({
    documentKind: "pass-purchase",
    orderId: source.orderId,
    dotyposCustomerId: source.dotyposCustomerId,
    locale,
    supplier: {
      ...source.supplier,
      commercialRegister: workspaceSiteConstants.company.commercialRegister,
    },
    buyer: input.buyer,
    delivery: source.delivery,
    paymentAttemptId: input.paymentAttemptId,
    invoiceNumber,
    issuedAt,
    serviceDate: source.serviceDate,
    payment: {
      status: "paid",
      date: plainDateStringSchema.make(
        temporalInstantToPlainDate({
          instant: input.paidAt,
          timeZone: workspaceSiteConstants.location.timeZone,
        }).toString()
      ),
    },
    currency: Schema.decodeUnknownSync(workspaceCurrencyCodeSchema)(
      quote.discountedSubtotal.currency
    ),
    variableSymbol: getInvoiceVariableSymbol(invoiceNumber),
    lines: [
      { description, price: moneyToDecimalString(quote.discountableSubtotal) },
      ...quote.discounts.map(({ amount, discount }) => ({
        description: discount.label,
        price: moneyToDecimalString({ ...amount, value: -amount.value }),
      })),
      ...(coffeeAmountMinor !== undefined
        ? [
            {
              description: m.checkoutSummaryItemCoffee({}, { locale }),
              price: moneyToDecimalString(
                moneyWithValue(coffeeAmountMinor, quote.discountedSubtotal)
              ),
            },
          ]
        : []),
    ],
    total: moneyToDecimalString(
      withPassPurchaseCoffee(quote.discountedSubtotal, coffeeAmountMinor)
    ),
    provenance: getInvoiceGenerationProvenance(issuedAt),
  });
};

const getInvoiceGenerationProvenance = (
  generatedAt: typeof instantStringSchema.Type
) => ({ system: "deskohub-workspace" as const, generatedAt });
