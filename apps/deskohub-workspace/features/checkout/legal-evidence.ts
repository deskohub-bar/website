import { legalEvidenceAcknowledgementsSchema } from "@deskohub/workspace-domain/features/checkout/legal-evidence";

export {
  type LegalEvidenceAcknowledgements,
  type LegalEvidenceEventId,
  legalEvidenceEventIdSchema,
} from "@deskohub/workspace-domain/features/checkout/legal-evidence";

import { Schema } from "effect";
import { locales } from "@/features/i18n";
import { instantStringSchema } from "@/shared/utils/temporal";

const legalDocumentKeys = [
  "termsAndConditions",
  "operatingRules",
  "privacyPolicy",
  "marketingCommunications",
] as const;

export const paymentSubmitLegalEvidenceSource = "payment_submit" as const;

const legalDocumentHashSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  hash: Schema.NonEmptyString,
  hashAlgorithm: Schema.Literal("sha256"),
});

export const legalEvidenceSchema = Schema.Struct({
  documentKey: Schema.Literals(legalDocumentKeys),
  documentHash: Schema.NonEmptyString,
  accepted: Schema.Boolean,
  acceptedAt: Schema.toEncoded(instantStringSchema),
  locale: Schema.Literals(locales),
  source: Schema.NonEmptyString,
  document: legalDocumentHashSchema,
  acknowledgements: Schema.optional(legalEvidenceAcknowledgementsSchema),
}).check(
  Schema.makeFilter(
    (evidence) => evidence.document.hash === evidence.documentHash,
    {
      path: ["documentHash"],
      message: "Legal evidence documentHash must match document.hash.",
    }
  )
);

export const legalEvidenceMapSchema = Schema.Record(
  Schema.NonEmptyString,
  legalEvidenceSchema
).check(
  Schema.makeFilter((evidenceMap) => {
    const mismatchedEntry = Object.entries(evidenceMap).find(
      ([documentHash, evidence]) => documentHash !== evidence.documentHash
    );

    return mismatchedEntry
      ? {
          path: [mismatchedEntry[0], "documentHash"],
          issue: "Legal evidence map key must match evidence.documentHash.",
        }
      : undefined;
  })
);

export type LegalEvidenceMap = typeof legalEvidenceMapSchema.Type;
