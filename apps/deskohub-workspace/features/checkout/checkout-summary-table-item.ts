import { workspaceTableProductIdentitySchema } from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Schema } from "effect";
import { positiveMoneyCodec } from "@/shared/money/money";
import {
  checkoutSummaryDiscountSchema,
  checkoutSummaryProductItemBaseSchema,
  checkoutSummaryProductKeyFilter,
} from "./checkout-summary-product-item";

const tableProductItemFields = {
  ...checkoutSummaryProductItemBaseSchema.fields,
  product: workspaceTableProductIdentitySchema,
  baseAmount: positiveMoneyCodec,
  usageAmount: positiveMoneyCodec,
};

export const tableCheckoutSummaryProductItemSchema = Schema.Struct({
  ...tableProductItemFields,
  originalAmount: Schema.optionalKey(Schema.Never),
  discounts: Schema.optionalKey(Schema.Never),
}).check(checkoutSummaryProductKeyFilter);

export const tableCheckoutSummaryDiscountedProductItemSchema = Schema.Struct({
  ...tableProductItemFields,
  originalAmount: positiveMoneyCodec,
  discounts: Schema.NonEmptyArray(checkoutSummaryDiscountSchema),
}).check(checkoutSummaryProductKeyFilter);
