import type {
  EmailTriggerEvent,
  EmailValueSnapshot,
} from "@deskohub/workspace-admin-api";
import type { Locale } from "@/features/i18n";
import { isLocale } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import type { PassTier } from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import { getPassReminderEndDates } from "@/features/passes/pass-reminder-schedule";
import {
  getEntryPackBookingPath,
  getUnlimitedRenewalPath,
} from "@/features/passes/routes";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { getWorkspaceCanonicalUrl } from "@/shared/utils/site-constants";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";

const formatPassReminderDate = (date: PlainDate, locale: Locale): string => {
  const english = locale === "en-US";
  const formatted = Temporal.PlainDate.from(date).toLocaleString(
    english ? "en-GB" : locale,
    { weekday: "short", day: "numeric", month: english ? "short" : "long" }
  );
  return english ? formatted.replace(",", "") : formatted;
};

export type PassReminderTriggerPayload =
  | {
      readonly trigger: "entry-pack-expiring";
      readonly firstName?: string | undefined;
      readonly tier: PassTier;
      readonly endsOn: PlainDate;
      readonly remainingEntries: number;
      readonly totalEntries: number;
      readonly actionUrl: string;
    }
  | {
      readonly trigger: "unlimited-ending";
      readonly firstName?: string | undefined;
      readonly tier: PassTier;
      readonly endsOn: PlainDate;
      readonly renewalStartsOn: PlainDate;
      readonly deskLabel?: string | undefined;
      readonly actionUrl: string;
    };

/** Formats live pass reminder fields as a resolved EmailValueSnapshot. */
export const passReminderTriggerSnapshot = (
  input: PassReminderTriggerPayload,
  locale: Locale
): EmailValueSnapshot => {
  const firstName = input.firstName?.trim() || null;
  const tier = getPassTierName(input.tier, locale);
  const endsOn = formatPassReminderDate(input.endsOn, locale);
  if (input.trigger === "entry-pack-expiring") {
    return {
      _tag: "Resolved",
      value: {
        firstName,
        tier,
        endsOn,
        remainingEntries: input.remainingEntries,
        totalEntries: input.totalEntries,
        actionUrl: input.actionUrl,
      },
    };
  }
  const deskLabel =
    input.tier === "open-space" ? null : input.deskLabel?.trim() || null;
  return {
    _tag: "Resolved",
    value: {
      firstName,
      tier,
      endsOn,
      renewalStartsOn: formatPassReminderDate(input.renewalStartsOn, locale),
      deskLabel,
      actionUrl: input.actionUrl,
    },
  };
};

const samplePassId = orderIdSchema.make("019c0000-0000-7000-8000-000000000000");

/** Synthetic pass reminder values for live editor and dry-run previews. */
export const sampleEmailTriggerValue = (
  trigger: EmailTriggerEvent,
  rawLocale: string,
  now: Temporal.Instant,
  omittedFields?: ReadonlySet<string>
): EmailValueSnapshot => {
  const locale: Locale = isLocale(rawLocale) ? rawLocale : "cs-CZ";
  const product =
    trigger === "entry-pack-expiring" ? "entry-pack" : "unlimited";
  const dueDate = plainDateStringSchema.make(getWorkspaceDate(now).toString());
  const { lastUsableDate: endsOn, validUntil } = getPassReminderEndDates(
    product,
    dueDate
  );
  const firstName = omittedFields?.has("firstName") ? undefined : "[firstName]";
  const actionUrl = getWorkspaceCanonicalUrl(
    product === "entry-pack"
      ? getEntryPackBookingPath(locale, samplePassId)
      : getUnlimitedRenewalPath(locale, samplePassId)
  );
  if (trigger === "entry-pack-expiring") {
    return passReminderTriggerSnapshot(
      {
        trigger,
        firstName,
        tier: "reserved-desk",
        endsOn,
        remainingEntries: 2,
        totalEntries: 5,
        actionUrl,
      },
      locale
    );
  }
  const deskLabel = omittedFields?.has("deskLabel") ? undefined : "Desk 14";
  return passReminderTriggerSnapshot(
    {
      trigger,
      firstName,
      tier: deskLabel ? "reserved-desk" : "open-space",
      endsOn,
      renewalStartsOn: validUntil,
      deskLabel,
      actionUrl,
    },
    locale
  );
};
