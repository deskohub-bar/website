export const reservationHoldTtlMilliseconds = 10 * 60 * 1000;

export const getReservationHoldExpiresAt = (now: Temporal.Instant) =>
  now.add({ milliseconds: reservationHoldTtlMilliseconds });
