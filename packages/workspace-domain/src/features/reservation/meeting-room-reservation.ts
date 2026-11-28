import { Schema } from "effect";
import { meetingRoomReservationDurationSchema } from "./meeting-room-reservation-duration";
import { meetingRoomReservationKind } from "./reservation-kind";

export const workspaceMeetingRoomProductIdentitySchema = Schema.Struct({
  kind: Schema.Literal(meetingRoomReservationKind),
  duration: meetingRoomReservationDurationSchema,
});

export const workspaceMeetingRoomProductTargetSchema = Schema.Struct({
  kind: workspaceMeetingRoomProductIdentitySchema.fields.kind,
});
