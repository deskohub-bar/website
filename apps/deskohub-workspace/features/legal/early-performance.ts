import { Match } from "effect";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import type { ReservationOrderData } from "@/features/reservation/reservation-order";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { isCzechWorkingDay } from "./czech-working-day";

const consumerWithdrawalPeriodDays = 14;

const getWorkspaceDateStart = (date: string | Temporal.PlainDate) =>
  Temporal.PlainDate.from(date)
    .toZonedDateTime(workspaceSiteConstants.location.timeZone)
    .toInstant();

const getReservationServiceStart = (
  reservation: ReservationOrderData
): Temporal.Instant =>
  Match.value(reservation).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: ({ date }) => getWorkspaceDateStart(date),
      "meeting-room": ({ startsAt }) => Temporal.Instant.from(startsAt),
      office: ({ startsOn }) => getWorkspaceDateStart(startsOn),
      table: ({ startsAt }) => Temporal.Instant.from(startsAt),
    })
  );

export const getEarlyPerformanceRequestRequiredAt = (
  reservation: ReservationOrderData
): Temporal.Instant => {
  const serviceDate = getWorkspaceDate(getReservationServiceStart(reservation));
  let precedingWorkingDay = serviceDate.subtract({ days: 1 });
  while (!isCzechWorkingDay(precedingWorkingDay)) {
    precedingWorkingDay = precedingWorkingDay.subtract({ days: 1 });
  }

  // Day 14 must fall after the preceding working day to reach the service date.
  return getWorkspaceDateStart(
    precedingWorkingDay
      .add({ days: 1 })
      .subtract({ days: consumerWithdrawalPeriodDays })
  );
};

/**
 * The contract date is excluded under §605. Under §607 the last day moves
 * forward to a Czech working day if day 14 is a weekend or public holiday.
 */
export function getLastConsumerWithdrawalDate(
  contractDate: Temporal.PlainDate
): Temporal.PlainDate {
  let lastDate = contractDate.add({ days: consumerWithdrawalPeriodDays });
  while (!isCzechWorkingDay(lastDate)) {
    lastDate = lastDate.add({ days: 1 });
  }
  return lastDate;
}

/** The exclusive cutoff at Prague midnight after the last withdrawal date. */
export const getConsumerWithdrawalPeriodCutoff = (
  contractAt: Temporal.Instant
): Temporal.Instant =>
  getWorkspaceDateStart(
    getLastConsumerWithdrawalDate(getWorkspaceDate(contractAt)).add({ days: 1 })
  );

export const isEarlyPerformanceRequestRequired = (input: {
  readonly reservation: ReservationOrderData;
  readonly contractAt: Temporal.Instant;
}) =>
  Temporal.Instant.compare(
    getReservationServiceStart(input.reservation),
    getConsumerWithdrawalPeriodCutoff(input.contractAt)
  ) < 0;
