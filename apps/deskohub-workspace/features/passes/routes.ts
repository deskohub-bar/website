import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import {
  getCoworkReservationPath,
  reservationAccessPath,
  reservationStatusPath,
} from "@/features/reservation/routes";

export const entryPackCheckoutPath = "/passes/entry-pack";
export const unlimitedPassCheckoutPath = "/passes/unlimited";

export const getEntryPackBookingPath = (locale: Locale, passId: OrderId) =>
  `${getCoworkReservationPath(locale)}?${new URLSearchParams({ pass: passId })}`;

export const getPassPurchaseStatusPath = (locale: Locale, orderId: OrderId) =>
  `/${locale}${reservationStatusPath}/${orderId}`;

export const withPassCheckoutHandoff = (path: string, token: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ handoff: token })}`;

export const getPassCheckoutHandoffPath = (
  locale: Locale,
  kind: "entry-pack" | "unlimited",
  token: string
) => {
  const path =
    kind === "entry-pack" ? entryPackCheckoutPath : unlimitedPassCheckoutPath;
  return withPassCheckoutHandoff(`/${locale}${path}?step=details`, token);
};

export const getUnlimitedRenewalPath = (locale: Locale, orderId: OrderId) =>
  `/${locale}${unlimitedPassCheckoutPath}?renew=${encodeURIComponent(orderId)}`;

export const getUnlimitedAccessPath = (locale: Locale, orderId: OrderId) =>
  `/${locale}${reservationAccessPath}/${encodeURIComponent(orderId)}`;
