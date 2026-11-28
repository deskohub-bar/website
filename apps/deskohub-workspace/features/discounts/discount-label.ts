import {
  type DiscountLabelLocale,
  type DiscountLabels,
  discountLabelLocales,
} from "@deskohub/workspace-domain/features/discounts/discount-label";

export {
  type DiscountLabelLocale,
  type DiscountLabels,
  discountLabelLocales,
} from "@deskohub/workspace-domain/features/discounts/discount-label";

import { getLocaleDefinition } from "@deskohub/i18n/locale-registry";
import type { Locale } from "@/features/i18n";

const isDiscountLabelLocale = (locale: Locale): locale is DiscountLabelLocale =>
  discountLabelLocales.some((labelLocale) => labelLocale === locale);

/**
 * A discount's label in `locale`: the label written in it, else the first
 * locale of its fallback chain that operators write labels in.
 */
export const discountLabelFor = (
  labels: DiscountLabels,
  locale: Locale
): string =>
  labels[
    [locale, ...getLocaleDefinition(locale).fallbackChain].find(
      isDiscountLabelLocale
    ) ?? discountLabelLocales[0]
  ];
