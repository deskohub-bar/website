import { AdministrationLink } from "@/features/administration/admin-link";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import { passHref } from "./pass-presentation";
import type { ReservationPassLink } from "./pass-reads";

export function ReservationPassBadge({
  link,
  locale,
}: {
  readonly link: ReservationPassLink;
  readonly locale: Locale;
}) {
  return (
    <AdministrationLink
      className="relative z-10 inline-flex"
      href={passHref(link.passId)}
    >
      <StatusBadge tone="neutral">
        {(link.product === "entry-pack"
          ? m.passesReservationPack
          : m.passesReservationUnlimited)({}, { locale })}
      </StatusBadge>
    </AdministrationLink>
  );
}
