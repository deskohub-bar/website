export {
  type ReservationInviteeId,
  type ReservationInviteeKeyId,
  reservationInviteeIdSchema,
  reservationInviteeKeyIdSchema,
} from "@deskohub/workspace-domain/features/reservation-invitees/reservation-invitee";

import { workspaceSiteConstants } from "@/shared/utils/site-constants";

/** How long an invitee's address outlives the reservation's access. */
const reservationInviteeRetentionDays = 30;

/**
 * When an invitee's address is due for deletion: 30 Prague calendar days
 * after `accessEndsAt`, the end of the reservation's access window. The
 * retention purge also honors a later access end recorded after the row was
 * written.
 */
export const getReservationInviteeRetainUntil = (
  accessEndsAt: Temporal.Instant
): Temporal.Instant =>
  accessEndsAt
    .toZonedDateTimeISO(workspaceSiteConstants.location.timeZone)
    .add({ days: reservationInviteeRetentionDays })
    .toInstant();
