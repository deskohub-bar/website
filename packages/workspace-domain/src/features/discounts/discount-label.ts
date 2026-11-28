import type { SupportedLocale as Locale } from "@deskohub/i18n/locale-registry";

/**
 * The locales an operator writes a discount's label in. Every other locale
 * reads one of them through its fallback chain (`discountLabelFor`).
 */
export const discountLabelLocales = [
  "en-US",
  "cs-CZ",
] as const satisfies readonly Locale[];

export type DiscountLabelLocale = (typeof discountLabelLocales)[number];

/** A discount's label in each locale operators write labels in. */
export type DiscountLabels = Readonly<Record<DiscountLabelLocale, string>>;
