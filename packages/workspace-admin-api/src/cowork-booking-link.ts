import { supportedLocales } from "@deskohub/i18n/locale-registry";
import { stripLocaleFromPathname } from "@deskohub/i18n/pathname";

export const workspaceSiteDomain = "workspace.deskohub.cz";
export const coworkReservationPath = "/reservation/cowork";
export const discountCodeQueryParam = "discountCode";

/** The Workspace cowork booking page is the only destination for a prefilled code. */
export const parseCoworkBookingLink = (href: string): URL | null => {
  const url = URL.parse(href);
  if (
    !url ||
    url.origin !== `https://${workspaceSiteDomain}` ||
    url.username ||
    url.password ||
    stripLocaleFromPathname(url.pathname, supportedLocales) !==
      coworkReservationPath
  )
    return null;
  return url;
};
