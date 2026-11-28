import "@/shared/polyfills/temporal";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Schema } from "effect";
import { reservationOrderSchema } from "@/features/reservation/reservation-order";
import {
  getConsumerWithdrawalPeriodCutoff,
  getEarlyPerformanceRequestRequiredAt,
  isEarlyPerformanceRequestRequired,
} from "./early-performance";

const contractAt = Temporal.Instant.from("2026-08-12T12:00:00Z");

beforeEach(() => setSystemTime(new Date("2025-12-31T12:00:00Z")));
afterEach(() => setSystemTime());

const coworkReservation = (date: string) =>
  Schema.decodeUnknownSync(reservationOrderSchema("CZ"))({
    kind: "cowork",
    entryTier: "basic",
    date,
    coffee: false,
    name: "Synthetic Customer",
    email: testEmailAddress("customer"),
    phone: "+420 700 000 000",
  });

describe("early-performance request", () => {
  test("uses the end of the fourteenth following Workspace calendar day", () => {
    expect(getConsumerWithdrawalPeriodCutoff(contractAt).toString()).toBe(
      "2026-08-26T22:00:00Z"
    );
    expect(
      isEarlyPerformanceRequestRequired({
        contractAt,
        reservation: coworkReservation("2026-08-26"),
      })
    ).toBe(true);
    expect(
      isEarlyPerformanceRequestRequired({
        contractAt,
        reservation: coworkReservation("2026-08-27"),
      })
    ).toBe(false);
  });

  test("identifies the exact instant when the request becomes applicable", () => {
    expect(
      getEarlyPerformanceRequestRequiredAt(
        coworkReservation("2026-08-27")
      ).toString()
    ).toBe("2026-08-12T22:00:00Z");
  });

  test.each([
    ["Saturday", "2026-11-28T12:00:00Z", "2026-12-14T23:00:00Z"],
    ["Sunday", "2026-11-29T12:00:00Z", "2026-12-14T23:00:00Z"],
    ["Czech Statehood Day", "2026-09-14T12:00:00Z", "2026-09-29T22:00:00Z"],
    ["Czech Flag Day", "2026-03-16T12:00:00Z", "2026-03-30T22:00:00Z"],
    ["Good Friday in 2024", "2024-03-15T12:00:00Z", "2024-04-02T22:00:00Z"],
    ["Good Friday in 2026", "2026-03-20T12:00:00Z", "2026-04-07T22:00:00Z"],
    ["Easter Monday in 2027", "2027-03-15T12:00:00Z", "2027-03-30T22:00:00Z"],
    ["July holidays", "2027-06-21T12:00:00Z", "2027-07-07T22:00:00Z"],
    [
      "Christmas and weekend in 2025",
      "2025-12-10T12:00:00Z",
      "2025-12-29T23:00:00Z",
    ],
    ["Christmas and weekend", "2026-12-10T12:00:00Z", "2026-12-28T23:00:00Z"],
    ["New Year and weekend", "2026-12-18T12:00:00Z", "2027-01-04T23:00:00Z"],
    ["Prague contract date", "2026-11-30T23:00:00Z", "2026-12-15T23:00:00Z"],
  ])("uses the adjusted Prague cutoff for %s", (_, confirmedAt, cutoff) => {
    expect(
      getConsumerWithdrawalPeriodCutoff(
        Temporal.Instant.from(confirmedAt)
      ).toString()
    ).toBe(cutoff);
  });

  test("requires consent on the extended final day", () => {
    const confirmedAt = Temporal.Instant.from("2026-11-28T12:00:00Z");
    const reservation = coworkReservation("2026-12-14");

    expect(
      isEarlyPerformanceRequestRequired({
        contractAt: confirmedAt,
        reservation,
      })
    ).toBe(true);
    expect(
      isEarlyPerformanceRequestRequired({
        contractAt: confirmedAt,
        reservation: coworkReservation("2026-12-15"),
      })
    ).toBe(false);
    expect(getEarlyPerformanceRequestRequiredAt(reservation).toString()).toBe(
      "2026-11-27T23:00:00Z"
    );
  });

  test("refreshes consent at the first applicable instant for every service date in 2026 and 2027", () => {
    const end = Temporal.PlainDate.from("2028-01-01");
    for (
      let serviceDate = Temporal.PlainDate.from("2026-01-01");
      Temporal.PlainDate.compare(serviceDate, end) < 0;
      serviceDate = serviceDate.add({ days: 1 })
    ) {
      const reservation = coworkReservation(serviceDate.toString());
      const requiredAt = getEarlyPerformanceRequestRequiredAt(reservation);
      expect({
        serviceDate: serviceDate.toString(),
        before: isEarlyPerformanceRequestRequired({
          contractAt: requiredAt.subtract({ milliseconds: 1 }),
          reservation,
        }),
        at: isEarlyPerformanceRequestRequired({
          contractAt: requiredAt,
          reservation,
        }),
      }).toEqual({
        serviceDate: serviceDate.toString(),
        before: false,
        at: true,
      });
    }
  });

  test("keeps the cutoff on the Workspace calendar across daylight saving", () => {
    expect(
      getConsumerWithdrawalPeriodCutoff(
        Temporal.Instant.from("2026-03-17T10:00:00Z")
      ).toString()
    ).toBe("2026-03-31T22:00:00Z");
    expect(
      getConsumerWithdrawalPeriodCutoff(
        Temporal.Instant.from("2026-10-20T10:00:00Z")
      ).toString()
    ).toBe("2026-11-03T23:00:00Z");
  });
});
