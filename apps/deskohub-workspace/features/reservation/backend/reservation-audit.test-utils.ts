import { customerAccountIdSchema } from "@/features/account/customer-account";
import type { ReservationAuditAttempt } from "./reservation-audit";

const operatorId = customerAccountIdSchema.make("synthetic-audit-operator");

export const makeTestReservationAuditAttempt = (): ReservationAuditAttempt => ({
  actorAccountId: operatorId,
  source: "admin-ui",
  correlationId: crypto.randomUUID(),
  rootEventId: crypto.randomUUID(),
  administrationActionId: null,
});
