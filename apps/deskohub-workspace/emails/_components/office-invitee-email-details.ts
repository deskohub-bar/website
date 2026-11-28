import {
  getWorkspaceOfficeProductTitle,
  getWorkspaceTableProductTitle,
} from "@/features/checkout/product-catalog.i18n";
import { type Locale, m } from "@/features/i18n";
import {
  formatReservationDisplayDateRange,
  formatReservationDisplayDateTimeRange,
} from "@/features/reservation/reservation-date";
import { workspaceSiteConstants } from "@/shared/utils";
import type { WorkspaceEmailDetail } from "../workspace-email-detail";

/** What an invited person's emails say about the space they were invited to. */
export interface OfficeInviteeEmailReservation {
  readonly reservedFrom: Temporal.Instant;
  readonly reservedUntil: Temporal.Instant;
  /** The booker's name, as the invitation names them. */
  readonly bookedBy: string;
  readonly teamTable?: { readonly name?: string };
}

/**
 * The space, its date and who booked it: all an invited person sees of the
 * order. Never the price, the references, the other people or a door code.
 */
export const officeInviteeEmailDetails = (
  reservation: OfficeInviteeEmailReservation,
  locale: Locale
): WorkspaceEmailDetail[] => [
  {
    label: m.officeInvitationSpaceLabel({}, { locale }),
    value: reservation.teamTable
      ? getWorkspaceTableProductTitle(locale)
      : getWorkspaceOfficeProductTitle(locale),
  },
  ...(reservation.teamTable?.name
    ? [
        {
          label: m.reservationAssignedTableLabel({}, { locale }),
          value: reservation.teamTable.name,
        },
      ]
    : []),
  {
    label: reservation.teamTable
      ? m.reservationEmailTimeLabel({}, { locale })
      : m.officeInvitationDateLabel({}, { locale }),
    value: (reservation.teamTable
      ? formatReservationDisplayDateTimeRange
      : formatReservationDisplayDateRange)(
      reservation.reservedFrom,
      reservation.reservedUntil,
      locale
    ),
  },
  {
    label: m.officeInvitationBookedByLabel({}, { locale }),
    value: reservation.bookedBy,
  },
];

/** Why the invited person got the email, and where to ask. */
export const officeInviteeEmailReason = (
  reservation: Pick<OfficeInviteeEmailReservation, "bookedBy">,
  locale: Locale
) =>
  m.officeInvitationReason(
    {
      booker: reservation.bookedBy,
      email: workspaceSiteConstants.contact.infoEmail,
    },
    { locale }
  );
