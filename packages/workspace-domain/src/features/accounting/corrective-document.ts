import { Schema } from "effect";

/** A corrective document's number in its own annual series, `WS-OD-YYYY-NNNNNN`. */
export const correctiveDocumentNumberSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^WS-OD-[0-9]{4}-[0-9]{6,}$/)),
  Schema.brand("CorrectiveDocumentNumber")
).annotate({
  identifier: "CorrectiveDocumentNumber",
  description: "Deskohub corrective document number.",
});

export type CorrectiveDocumentNumber =
  typeof correctiveDocumentNumberSchema.Type;
