import { Schema } from "effect";

export const accountingSnapshotKeyIdSchema = Schema.NonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]{2,31}$/)
)
  .pipe(Schema.brand("AccountingSnapshotKeyId"))
  .annotate({
    identifier: "AccountingSnapshotKeyId",
    description: "Identifier selecting an accounting snapshot encryption key.",
  });

export type AccountingSnapshotKeyId = typeof accountingSnapshotKeyIdSchema.Type;
