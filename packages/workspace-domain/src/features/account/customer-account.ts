import { Schema } from "effect";

export const customerAccountIdSchema = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255)
)
  .pipe(Schema.brand("CustomerAccountId"))
  .annotate({
    identifier: "CustomerAccountId",
    description: "Opaque identifier assigned by Better Auth.",
  });

export type CustomerAccountId = typeof customerAccountIdSchema.Type;
