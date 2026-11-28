import { AdministrationLink } from "@/features/administration/admin-link";
import { administrationHref } from "@/features/administration/administration-href";
import { getAdministrationCustomerName } from "@/features/administration/customer-presentation";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import {
  StatusBadge,
  type StatusTone,
} from "@/shared/components/ui/status-badge";
import { formatMoney } from "@/shared/money/money";
import { formatCount } from "@/shared/utils/number";
import { formatPassDate } from "../pass-offer.i18n";
import type {
  AdminPassParty,
  AdminPassStatus,
  AdminPassSummary,
} from "./pass-list-contract";

const passStatusMessages = {
  pending_payment: m.passesPendingPayment,
  active: m.passesActive,
  scheduled: m.passesScheduled,
  depleted: m.passesDepleted,
  expired: m.passesExpired,
  cancelled: m.passesCancelled,
  withdrawn: m.passesWithdrawn,
  void: m.passesVoid,
};

const passStatusTones = {
  pending_payment: "progress",
  active: "positive",
  scheduled: "progress",
  depleted: "neutral",
  expired: "neutral",
  cancelled: "attention",
  withdrawn: "attention",
  void: "neutral",
} satisfies Record<AdminPassStatus, StatusTone>;

export const passStatusLabel = (status: AdminPassStatus, locale: Locale) =>
  passStatusMessages[status]({}, { locale });

export function PassStatusBadge({
  status,
  locale,
}: {
  readonly status: AdminPassStatus;
  readonly locale: Locale;
}) {
  return (
    <StatusBadge tone={passStatusTones[status]}>
      {passStatusLabel(status, locale)}
    </StatusBadge>
  );
}

export const passHref = (passId: OrderId) =>
  administrationHref("/[locale]/admin/passes/[passId]", { passId });

export const passProductLabel = (
  product: AdminPassSummary["product"],
  locale: Locale
) =>
  (product === "entry-pack" ? m.passesEntryPack : m.passesUnlimited)(
    {},
    { locale }
  );

export const passProductTitle = (pass: AdminPassSummary, locale: Locale) =>
  pass.entryCount === null
    ? m.passesUnlimitedDuration(
        {
          count: formatCount(
            Temporal.PlainDate.from(pass.validFrom).until(pass.validUntil).days,
            locale
          ),
        },
        { locale }
      )
    : m.passesEntryPackSize(
        { count: formatCount(pass.entryCount, locale) },
        { locale }
      );

export const passRemainingLabel = (pass: AdminPassSummary, locale: Locale) => {
  if (pass.entriesLeft !== null && pass.entryCount !== null) {
    return m.passesEntriesLeft(
      {
        left: formatCount(pass.entriesLeft, locale),
        total: formatCount(pass.entryCount, locale),
      },
      { locale }
    );
  }
  if (pass.day === null) return "—";
  const total = Temporal.PlainDate.from(pass.validFrom).until(
    pass.validUntil
  ).days;
  return m.passesDayOf(
    { day: formatCount(pass.day, locale), total: formatCount(total, locale) },
    { locale }
  );
};

export const passLastDate = (pass: AdminPassSummary, locale: Locale) => {
  const cutoff = pass.accessEndsOn ?? pass.validUntil;
  if (cutoff <= pass.validFrom) return null;
  return formatPassDate(
    Temporal.PlainDate.from(cutoff).subtract({ days: 1 }).toString(),
    locale
  );
};

export const passValidityRange = (pass: AdminPassSummary, locale: Locale) => {
  const lastDay = passLastDate(pass, locale);
  return lastDay
    ? `${formatPassDate(pass.validFrom, locale)} – ${lastDay}`
    : m.passesNoAccessDays({}, { locale });
};

export const passPaidLabel = (pass: AdminPassSummary, locale: Locale) => {
  if (pass.complimentary) return m.passesGranted({}, { locale });
  return pass.paid ? formatMoney(pass.paid, locale) : "—";
};

export const passPartyLabel = (
  party: AdminPassParty,
  locale: Locale
): string => {
  if (party.deleted) return m.passesDeletedParty({}, { locale });
  return party.name
    ? getAdministrationCustomerName(party.name, locale)
    : (party.email ?? m.passesUnavailableParty({}, { locale }));
};

export function PassPartyName({
  party,
  locale,
}: {
  readonly party: AdminPassParty;
  readonly locale: Locale;
}) {
  const name = passPartyLabel(party, locale);
  return (
    <>
      {party.customerId ? (
        <AdministrationLink
          className="underline decoration-navy-blue/25 underline-offset-2 hover:decoration-current"
          href={administrationHref("/[locale]/admin/customers/[customerId]", {
            customerId: party.customerId,
          })}
        >
          {name}
        </AdministrationLink>
      ) : (
        name
      )}
      {party.email && party.email !== name && (
        <p className="break-all text-xs text-navy-blue/65">{party.email}</p>
      )}
    </>
  );
}
