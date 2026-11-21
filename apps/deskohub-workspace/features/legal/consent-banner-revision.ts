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
      "3f36b29f196c659d2672472007e43f35dc08ff0b16a1ff09af1a50326c4dd3f8",
    "cookie-policy":
      "2f705c21210f6fc44919ba388ddf4456abad86fa88dee41a25d87df7c0f42033",
  },
  "cs-CZ": {
    "privacy-policy":
      "06ef7eccee6ae782d255f20318a23487b3a6919d9abf6da1310aa0c4355ffaba",
    "cookie-policy":
      "8aa600ff58b9d8d896dbe63f55b98774211ea53d031e8021815916b9b11957b6",
  },
  "de-DE": {
    "privacy-policy":
      "12971bc012fa60f835e50ebfa162649dd15138ab5cdcb75f90c9f6cc0e439fb5",
    "cookie-policy":
      "c1754e2cda352680810ee0826c73ad6149b37b3d9ce2d89b1c9f7ebef49b3934",
  },
  "uk-UA": {
    "privacy-policy":
      "5e2fb2f96c5600e33892e1a8d6b348fab61fcfc94c552529c2ab19466c6c932e",
    "cookie-policy":
      "46d2f95acd2e8de5cd0a4fc0bb62aea6ac9475357228f44d9b071194ced0ed5b",
  },
  "sk-SK": {
    "privacy-policy":
      "b5f247ecb4e7311ee0847aaf5f141310cd1ff37a34b87e2ca6fc792b7d8f32a3",
    "cookie-policy":
      "39dd69f612391cf5f4a62a11de40e45270ce12dd3c59ab98e5811533bd3b561b",
  },
  "vi-VN": {
    "privacy-policy":
      "b2a920b3aeca14d6321ef1bfa0f762076ccf365bb483664a19f8f26c753912fc",
    "cookie-policy":
      "45b40480e12b3e026438562a8263bfb64f5804a257c669e65ce9c85c59deef9e",
  },
  "hi-IN": {
    "privacy-policy":
      "feeaa3947ca6aeca453a0c49ff09cff76c7d48fd381b5521ac3d51fa65614330",
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
