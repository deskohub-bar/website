import { createHash } from "node:crypto";
import { type Locale, locales } from "@/features/i18n";
import type { LegalDocumentKey } from "./legal-document-summaries";

/** The documents a cookie consent choice is made under. */
const consentBannerDocuments = [
  "privacy-policy",
  "cookie-policy",
] as const satisfies readonly LegalDocumentKey[];

type ConsentBannerDocument = (typeof consentBannerDocuments)[number];

/**
 * The published version (`getLegalDocumentVersion`) of each document the
 * banner is bound to, per locale whose legal documents are published. A copy,
 * so the server's consent cookie readers, which every request loads, never
 * load the legal texts or React; a test fails with the current versions
 * whenever either document changes in any locale.
 *
 * Recording a new locale's versions here changes the banner revision, which
 * reopens the cookie banner for every visitor.
 */
export const consentBannerDocumentVersions: Readonly<
  Partial<Record<Locale, Readonly<Record<ConsentBannerDocument, string>>>>
> = {
  "en-US": {
    "privacy-policy":
      "7ca3873ddc2c9bd6977fb9aa3968098fffc64557c728b653b2ff029068bf4d92",
    "cookie-policy":
      "2f705c21210f6fc44919ba388ddf4456abad86fa88dee41a25d87df7c0f42033",
  },
  "cs-CZ": {
    "privacy-policy":
      "fbe427f73353085e6a227fae7031c61be1c99de52ecfe2a31dd0ec22d1fbddb8",
    "cookie-policy":
      "8aa600ff58b9d8d896dbe63f55b98774211ea53d031e8021815916b9b11957b6",
  },
  "de-DE": {
    "privacy-policy":
      "210b477d135610028fc1684644d53adc27cbaf96613f6ecf1e47a5f4d826a204",
    "cookie-policy":
      "c1754e2cda352680810ee0826c73ad6149b37b3d9ce2d89b1c9f7ebef49b3934",
  },
  "uk-UA": {
    "privacy-policy":
      "5b1da49fd89873cf665b7edf27a637b5280f118af6f6098ffca7591289259ca6",
    "cookie-policy":
      "46d2f95acd2e8de5cd0a4fc0bb62aea6ac9475357228f44d9b071194ced0ed5b",
  },
  "sk-SK": {
    "privacy-policy":
      "f464b6cbc710bdd8836f2e24a2ff06e7a06d79b08b18b86610db9a7c3654f610",
    "cookie-policy":
      "39dd69f612391cf5f4a62a11de40e45270ce12dd3c59ab98e5811533bd3b561b",
  },
  "vi-VN": {
    "privacy-policy":
      "431ae005187d8f28439b3d0d61d994b20b599e91ad1634c92fa6833c673e9bb2",
    "cookie-policy":
      "45b40480e12b3e026438562a8263bfb64f5804a257c669e65ce9c85c59deef9e",
  },
  "hi-IN": {
    "privacy-policy":
      "890971196d692443d93fa70acd612bdf695a3a1d19960a795426865b2e2f8526",
    "cookie-policy":
      "1a1525e0af085f8817a19e2108f592ae8213e6427676c1947a5c3002c9f0b9bb",
  },
};

const publishedVersionOf = (
  locale: Locale,
  documentKey: ConsentBannerDocument
): string | undefined => consentBannerDocumentVersions[locale]?.[documentKey];

/**
 * The cookie banner revision of the privacy notice and cookie policy in every
 * locale: a positive safe integer that changes whenever either document
 * changes in any locale, which invalidates every saved consent choice and
 * reopens the banner. Switching the site language never changes it. Never 0,
 * the revision every consent cookie saved before the banner was bound to the
 * documents carries. `versionOf` defaults to the published versions.
 */
export function getConsentBannerRevision(
  versionOf: (
    locale: Locale,
    documentKey: ConsentBannerDocument
  ) => string | undefined = publishedVersionOf
): number {
  // Only locales with recorded versions count, in registry order.
  const versions = locales.flatMap((locale) =>
    consentBannerDocuments.flatMap((documentKey) => {
      const version = versionOf(locale, documentKey);
      return version === undefined ? [] : [version];
    })
  );
  const digest = createHash("sha256").update(versions.join("\n")).digest("hex");
  // 48 bits stay well inside Number.MAX_SAFE_INTEGER.
  return Number.parseInt(digest.slice(0, 12), 16) || 1;
}
