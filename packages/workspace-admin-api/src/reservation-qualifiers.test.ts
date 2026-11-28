import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { AudienceFilter } from "./audience-filter";
import { AutomationTrigger } from "./email-automations";

const cowork = { family: "cowork", properties: [] };
const meetingRoom = { family: "meeting-room", properties: [] };

const reservationCount = (params: Schema.JsonObject) => ({
  attribute: "reservationCount",
  _tag: "Condition",
  params: { period: { _tag: "Last", count: 60, unit: "day" }, ...params },
  operator: "gte",
  value: 2,
});

describe("reservationCount stay and payment", () => {
  const decode = Schema.decodeUnknownResult(AudienceFilter);

  test.each([
    [
      "a cowork stay by visit end",
      { dateBasis: "visitEnd", stay: "overnight", product: cowork },
    ],
    [
      "a cowork stay by visit date",
      { dateBasis: "visit", stay: "day", product: cowork },
    ],
    [
      "an individual payment by booking date",
      { dateBasis: "booking", payment: "individual" },
    ],
    [
      "both qualifiers",
      {
        dateBasis: "visitEnd",
        stay: "day",
        payment: "individual",
        product: cowork,
      },
    ],
    ["neither qualifier", { dateBasis: "visit" }],
  ])("accepts %s", (_, params) => {
    expect(Result.isSuccess(decode(reservationCount(params)))).toBe(true);
  });

  test.each([
    [
      "a stay by booking date",
      { dateBasis: "booking", stay: "day", product: cowork },
    ],
    ["a stay without a product", { dateBasis: "visitEnd", stay: "day" }],
    [
      "a stay of another family",
      { dateBasis: "visitEnd", stay: "day", product: meetingRoom },
    ],
    [
      "an unknown stay",
      { dateBasis: "visitEnd", stay: "week", product: cowork },
    ],
    ["an unknown payment", { dateBasis: "visit", payment: "pass" }],
    [
      "a Team Table campaign filter",
      { dateBasis: "visit", product: { family: "table", properties: [] } },
    ],
  ])("rejects %s", (_, params) => {
    expect(Result.isFailure(decode(reservationCount(params)))).toBe(true);
  });
});

describe("reservation trigger stay and payment", () => {
  const decode = Schema.decodeUnknownResult(AutomationTrigger);
  const reservationTriggers = [
    "ReservationBooked",
    "ReservationCancelled",
    "ReservationStarted",
    "ReservationFinished",
  ] as const;

  test.each(reservationTriggers)(
    "%s accepts a cowork stay and an individual payment",
    (tag) => {
      expect(
        Result.isSuccess(
          decode({
            _tag: tag,
            product: cowork,
            stay: "day",
            payment: "individual",
          })
        )
      ).toBe(true);
      expect(
        Result.isSuccess(decode({ _tag: tag, payment: "individual" }))
      ).toBe(true);
      expect(Result.isSuccess(decode({ _tag: tag }))).toBe(true);
    }
  );

  test.each(reservationTriggers)("%s rejects a stay outside cowork", (tag) => {
    expect(Result.isFailure(decode({ _tag: tag, stay: "overnight" }))).toBe(
      true
    );
    expect(
      Result.isFailure(decode({ _tag: tag, stay: "day", product: meetingRoom }))
    ).toBe(true);
  });

  test("keeps the qualifiers off other triggers", () => {
    const decoded = decode({ _tag: "AccountCreated", stay: "day" });
    expect(Result.getOrThrow(decoded)).toEqual({ _tag: "AccountCreated" });
  });
});
