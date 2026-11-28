import { Schema } from "effect";

export const sealedStateKeyIdSchema = Schema.Trim.check(Schema.isNonEmpty())
  .pipe(Schema.brand("SealedStateKeyId"))
  .annotate({
    identifier: "SealedStateKeyId",
    description: "Identifier selecting a sealed state encryption key.",
  });

export type SealedStateKeyId = typeof sealedStateKeyIdSchema.Type;
