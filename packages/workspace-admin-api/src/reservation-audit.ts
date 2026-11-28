import { Schema } from "effect";

export const reservationAuditStates = [
  "held",
  "hold_expired",
  "confirmed",
  "cancelling",
  "cancellation_failed",
  "cancelled",
] as const;

export const reservationAuditReasons = [
  "operator_cancellation",
  "forced_pending_payment_cancellation",
  "cancellation_reclaimed",
  "provider_cancellation_failed",
  "local_cancellation_failed",
  "cancellation_completed",
  "operator_restoration",
] as const;

const auditUuid = Schema.String.check(Schema.isUUID());

const ReservationAuditEvent = Schema.Struct({
  id: auditUuid,
  actorAccountId: Schema.NonEmptyString,
  source: Schema.Literals(["admin-ui", "dhw-cli", "assistant"]),
  beforeState: Schema.Literals(reservationAuditStates),
  afterState: Schema.Literals(reservationAuditStates),
  reason: Schema.Literals(reservationAuditReasons),
  occurredAt: Schema.String,
  correlationId: auditUuid,
  administrationActionId: Schema.NullOr(auditUuid),
  causedByEventId: Schema.NullOr(auditUuid),
  schemaVersion: Schema.Literal(1),
});

export const AdministrationReservationAuditQuery = Schema.Struct({
  before: Schema.optionalKey(auditUuid),
});
export type AdministrationReservationAuditQuery =
  typeof AdministrationReservationAuditQuery.Type;

export const AdministrationReservationAuditPage = Schema.Struct({
  reservationId: Schema.NonEmptyString,
  events: Schema.Array(ReservationAuditEvent),
  nextBefore: Schema.NullOr(auditUuid),
});
export type AdministrationReservationAuditPage =
  typeof AdministrationReservationAuditPage.Type;
