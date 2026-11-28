import { Schema } from "effect";
import { plainDateStringSchema } from "../../../shared/utils/temporal";
import { customerAccountIdSchema } from "../../account/customer-account";
import { passTiers } from "../../passes/pass-offer";

export const common = {
  copyVersion: Schema.Literal(1),
  holderAccountId: customerAccountIdSchema,
  holderVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tier: Schema.Literals(passTiers),
  endsOn: plainDateStringSchema,
};

/** Pass facts for rendering and replay. Names and email addresses stay live. */
export const passReminderContext = Schema.Union([
  Schema.Struct({
    ...common,
    product: Schema.Literal("entry-pack"),
    remainingEntries: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: 10 })
    ),
    totalEntries: Schema.Literals([5, 10]),
  }).check(
    Schema.makeFilter(
      ({ remainingEntries, totalEntries }) => remainingEntries <= totalEntries
    )
  ),
  Schema.Struct({
    ...common,
    product: Schema.Literal("unlimited"),
    renewalStartsOn: plainDateStringSchema,
    deskLabel: Schema.optionalKey(
      Schema.NonEmptyString.check(Schema.isMaxLength(120))
    ),
  }),
]);

export type PassReminderContext = typeof passReminderContext.Type;
