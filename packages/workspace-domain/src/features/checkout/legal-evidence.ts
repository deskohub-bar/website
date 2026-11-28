import { Schema } from "effect";

export const legalEvidenceEventIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("LegalEvidenceEventId")
).annotate({
  identifier: "LegalEvidenceEventId",
  description: "Opaque identifier for a persisted legal evidence event.",
});

export type LegalEvidenceEventId = typeof legalEvidenceEventIdSchema.Type;

/**
 * Customer acknowledgements captured with an accepted document. One
 * early-performance consent fact covers the combined early-performance request
 * and withdrawal-right acknowledgement behind the single checkout choice.
 * Checkout rejects payment when that consent is required but not given, so
 * the fact is only ever recorded as granted.
 */
export const legalEvidenceAcknowledgementsSchema = Schema.Struct({
  earlyPerformanceConsent: Schema.optionalKey(Schema.Literal(true)),
  entryPackEarlyStartRequested: Schema.optionalKey(Schema.Literal(true)),
  unlimitedPassEarlyStartRequested: Schema.optionalKey(Schema.Literal(true)),
}).annotate({
  identifier: "LegalEvidenceAcknowledgements",
  description:
    "Acknowledgements the customer gave together with an accepted legal document.",
});

export type LegalEvidenceAcknowledgements =
  typeof legalEvidenceAcknowledgementsSchema.Type;
