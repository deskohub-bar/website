import { Effect } from "effect";
import { appendVercelPreviewProtectionBypass } from "@/features/checkout/backend/checkout/vercel-preview-protection-bypass";
import type { Locale } from "@/features/i18n";
import { getLocalizedPagePath } from "@/features/i18n/routing";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";

const marketingPreferencesAccessUrl = (
  token: string,
  origin: URL,
  locale?: Locale
): URL => {
  const pathname =
    locale === undefined
      ? "/marketing-preferences/access"
      : getLocalizedPagePath(locale, "/[locale]/marketing-preferences/access");
  const url = new URL(pathname, origin);
  url.searchParams.set("token", token);
  return url;
};

/**
 * Absolute link that opens a customer's marketing preferences with a token
 * from `MarketingManagementService.issue`. Links in email omit the locale so
 * the proxy can choose the recipient's language.
 */
export const getMarketingPreferencesAccessUrl = (
  token: string,
  origin: URL,
  locale?: Locale
): string => {
  const url = marketingPreferencesAccessUrl(token, origin, locale);
  appendVercelPreviewProtectionBypass(url, { setBypassCookie: true });

  return url.href;
};

/** The marketing preferences link on the running deployment's origin. */
export const getRuntimeMarketingPreferencesAccessUrl = (
  token: string,
  locale?: Locale
) =>
  getWorkspaceRuntimeCallbackOrigin.pipe(
    Effect.map((origin) =>
      getMarketingPreferencesAccessUrl(token, origin, locale)
    )
  );

/**
 * Stands in for the marketing preferences link where there is no recipient:
 * admin previews and campaign test emails. Its token opens no preferences,
 * and it carries no preview protection bypass, because those emails are
 * shown and logged outside a recipient's inbox.
 */
export const getRuntimeMarketingPreferencesPlaceholderUrl =
  getWorkspaceRuntimeCallbackOrigin.pipe(
    Effect.map(
      (origin) => marketingPreferencesAccessUrl("preview", origin).href
    )
  );
