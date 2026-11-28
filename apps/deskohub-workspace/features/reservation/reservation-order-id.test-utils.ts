import { Option } from "effect";
import type { OrderId } from "@/features/order";
import {
  findReservationOrderId,
  type WorkspaceReservationId,
} from "./persistence-contracts";

/**
 * The order a standalone test reservation is mirrored into. Throws for pass
 * days, review samples, and other IDs without an order of their own.
 */
export const standaloneReservationOrderId = (
  reservationId: WorkspaceReservationId
): OrderId => Option.getOrThrow(findReservationOrderId(reservationId));
