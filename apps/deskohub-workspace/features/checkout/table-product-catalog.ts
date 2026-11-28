import { tableReservationSlotMinutes } from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { currencyCZK } from "@/shared/money/currencies";

export const getTableBaseAmount = (seats: number) => currencyCZK(6_000 * seats);

export const getTableUsageAmount = (seats: number, durationMinutes: number) =>
  currencyCZK(500 * seats * (durationMinutes / tableReservationSlotMinutes));
