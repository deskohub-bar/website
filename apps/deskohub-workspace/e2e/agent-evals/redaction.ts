import { algoPinLength } from "@deskohub/igloohome";
import { Array as EffectArray } from "effect";
import type { Json } from "effect/Schema";
import { escapeRegExp } from "@/shared/utils/escape-regexp";
import { redactDiagnosticText } from "../redaction";

const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const uuidPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Door access PINs and provider IDs (Dotypos reservations and customers,
// payment orders) are long digit runs; prices, seat counts, and street
// numbers are short.
const longNumberPattern = new RegExp(
  `(?<![\\w.,])\\d{${algoPinLength.minimum},}(?![\\w])`,
  "g"
);
// Same-origin paths to reservation, checkout, and account pages carry
// reservation identifiers and access tokens just as full URLs do.
const sitePathPattern =
  /(?<![\w.])\/(?:[a-z]{2}-[A-Z]{2}\/)?(?:reservation|checkout|account)\/[^\s"'<>)]*/g;

/**
 * Redacts agent output (final answer, error, stderr) before it reaches a
 * run's artifacts: the run's own identifiers (account, profiles,
 * reservations, payment orders), registered secrets such as the bypass,
 * URLs and site paths (preview, status, and payment links carry access
 * tokens), token-like runs, email addresses, UUIDs, and long numbers such
 * as access PINs.
 */
export const redactAgentEvalOutput = (
  text: string,
  identifiers: readonly string[]
): string => {
  const withoutIdentifiers = [...new Set(identifiers)]
    .filter((identifier) => identifier.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (output, identifier) =>
        output.replace(
          new RegExp(
            `(?<![A-Za-z0-9])${escapeRegExp(identifier)}(?![A-Za-z0-9])`,
            "g"
          ),
          "[id]"
        ),
      text
    );
  return redactDiagnosticText(withoutIdentifiers)
    .replace(sitePathPattern, "[path]")
    .replace(emailPattern, "[email]")
    .replace(uuidPattern, "[id]")
    .replace(longNumberPattern, "[number]");
};

/**
 * Redacts every string in a JSON value, such as a saved judge input, the way
 * `redactAgentEvalOutput` redacts text. Keys and non-string values stay.
 */
export const redactAgentEvalValue = (
  value: Json,
  identifiers: readonly string[]
): Json => {
  if (typeof value === "string") {
    return redactAgentEvalOutput(value, identifiers);
  }
  if (EffectArray.isArray<Json>(value)) {
    return value.map((entry) => redactAgentEvalValue(entry, identifiers));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).flatMap((key) => {
        const entry = value[key];
        return entry === undefined
          ? []
          : [[key, redactAgentEvalValue(entry, identifiers)] as const];
      })
    );
  }
  return value;
};
