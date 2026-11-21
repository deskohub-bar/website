import { type Locale, m } from "@/features/i18n";
import type { PassTier } from "./pass-offer";

const tierNames = {
  "open-space": m.passTierOpenSpace,
  "reserved-desk": m.passTierReservedDesk,
  "reserved-desk-workstation": m.passTierWorkstation,
};

export const getPassTierName = (tier: PassTier, locale: Locale) =>
  tierNames[tier]({}, { locale });

export const formatPassDate = (date: string, locale: Locale) =>
  Temporal.PlainDate.from(date).toLocaleString(locale, { dateStyle: "medium" });
