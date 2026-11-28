import {
  coworkReservationKind,
  meetingRoomReservationKind,
  officeReservationKind,
  tableReservationKind,
} from "@deskohub/workspace-domain/features/reservation/reservation-kind";

export {
  coworkReservationKind,
  meetingRoomReservationKind,
  officeReservationKind,
  tableReservationKind,
} from "@deskohub/workspace-domain/features/reservation/reservation-kind";

import { Schema } from "effect";

export const workspaceReservationKindSchema = Schema.Literals([
  coworkReservationKind,
  meetingRoomReservationKind,
  officeReservationKind,
  tableReservationKind,
]);

export type WorkspaceReservationKind =
  typeof workspaceReservationKindSchema.Type;
