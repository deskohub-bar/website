import { createLocaleActionMiddleware } from "@deskohub/i18n/action";
import { baseLocale, type Locale } from "@/features/i18n";
import { resolveActionLocale } from "@/features/i18n/server/action-locale";
import { requestLocaleScope } from "@/features/i18n/server/request-locale-scope";

export type ResolveIssuedActionLocale = Parameters<
  typeof createLocaleActionMiddleware<Locale>
>[0]["resolveLocale"];

export const makeLocaleMiddleware = (
  resolveIssuedLocale?: ResolveIssuedActionLocale
) =>
  createLocaleActionMiddleware({
    resolveLocale: async (clientInput) =>
      (await resolveIssuedLocale?.(clientInput)) ??
      (await resolveActionLocale()),
    fallbackLocale: baseLocale,
    scope: requestLocaleScope,
  });
