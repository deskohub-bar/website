import { Schema } from "effect";
import { plainDateStringSchema } from "../../../shared/utils/temporal";
import { customerAccountIdSchema } from "../../account/customer-account";
import { entryPackProductSchema } from "../pass-offer";
import { unlimitedPassSelectionSchema } from "../unlimited-pass";

export const refundValueSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 })
);

export const passGrantSelectionSchema = Schema.Union([
  entryPackProductSchema,
  unlimitedPassSelectionSchema,
]);

export const makePassChangeSchema = <CustomerId extends Schema.Top>(
  customerId: CustomerId
) =>
  Schema.TaggedUnion({
    grant: {
      holderAccountId: customerAccountIdSchema,
      selection: passGrantSelectionSchema,
    },
    validity: {
      expectedValidUntil: plainDateStringSchema,
      lastDay: plainDateStringSchema,
      refundValue: refundValueSchema,
    },
    cancel: {
      expectedValidUntil: plainDateStringSchema,
      refundValue: refundValueSchema,
      sendCancellationEmail: Schema.Boolean,
    },
    reassign: {
      expectedHolderAccountId: customerAccountIdSchema,
      expectedHolderVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      holderAccountId: customerAccountIdSchema,
      holderCustomerId: Schema.optionalKey(customerId),
    },
  });

export type PassChange<CustomerId extends Schema.Top> = ReturnType<
  typeof makePassChangeSchema<CustomerId>
>["Type"];
