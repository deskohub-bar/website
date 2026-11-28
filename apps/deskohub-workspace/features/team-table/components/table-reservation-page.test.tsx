import "@/shared/testing/workspace-test-env";

import { expect, mock, spyOn, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect } from "effect";
import { checkoutSessionIdSchema } from "@/features/checkout/checkout-identifiers";
import { recordReservationPagePreloads } from "@/features/reservation/backend/reservation-page-preloads.service.mock";
import { defaultReservationBillingSelection } from "@/features/reservation/reservation-billing";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { normalizedTableReservationOrderSchema } from "@/features/reservation/table-reservation";
import { getTableReservationInterval } from "@/features/reservation/table-reservation-time";

mock.module("next/root-params", () => ({
  locale: () => Promise.resolve("en-US"),
}));

const { tableReservationPage } = await import("./table-reservation-page");

const locale = "en-US";
const today = getCurrentWorkspaceDate();
const date = today.add({ days: 2 }).toString();

const verifiedHold = (heldDate: string) => {
  const interval = getTableReservationInterval(heldDate, "09:00", "10:15");
  if (!interval) throw new Error("Expected a valid test interval");
  return {
    officeSelection: {
      kind: "people" as const,
      people: { contactAttends: false, invitees: [testEmailAddress("guest")] },
    },
    reservation: normalizedTableReservationOrderSchema.make({
      kind: "table",
      seats: 6,
      ...interval,
      name: "Ada Lovelace",
      email: testEmailAddress("booker"),
      phone: "+420777000111",
      billing: defaultReservationBillingSelection,
    }),
    checkoutSessionId: checkoutSessionIdSchema.make("active-table-session"),
    replacementToken: "verified-pay-state",
  };
};

test("preloads the linked table size's six-month calendar and exact price request", async () => {
  const preloads = recordReservationPagePreloads();
  const content = await Effect.runPromise(
    tableReservationPage
      .loadContent({
        checkoutAccount: { status: "signed-out" },
        locale,
        pageData: [4, 6],
        searchParams: {
          date,
          seats: "6",
          startTime: "09:15",
          endTime: "09:45",
        },
      })
      .pipe(Effect.provide(preloads.layer))
  );
  expect(content.kind).toBe("form");
  if (content.kind !== "form") throw new Error("Expected a booking form");
  expect(content.form.initialValues).toMatchObject({
    date,
    seats: 6,
    startTime: "09:15",
    endTime: "09:45",
  });
  expect(preloads.availabilityPreloads[0]?.queries).toEqual([
    {
      kind: "table",
      from: today.toString(),
      to: today.add({ months: 6 }).toString(),
      seats: 6,
    },
  ]);
  expect(preloads.advertisedPriceRequests[0]).toEqual([
    {
      locale,
      reservation: {
        kind: "table",
        details: {
          kind: "table",
          seats: 6,
          ...getTableReservationInterval(date, "09:15", "09:45"),
        },
      },
    },
  ]);
});

test.each([
  {
    capacities: [4, 6],
    expectedSeats: 6,
    startTime: "09:00",
    endTime: "10:15",
  },
  { capacities: [4], expectedSeats: 0, startTime: "", endTime: "" },
])(
  "requires an explicit replacement when a held Team Table size is retired: $capacities",
  async ({ capacities, expectedSeats, startTime, endTime }) => {
    const preloads = recordReservationPagePreloads();
    const hold = verifiedHold(date);
    const content = await Effect.runPromise(
      tableReservationPage
        .loadContent({
          checkoutAccount: { status: "signed-out" },
          locale,
          pageData: capacities,
          searchParams: {},
          restoredReservation: hold,
        })
        .pipe(Effect.provide(preloads.layer))
    );
    expect(content.kind).toBe("form");
    if (content.kind !== "form") throw new Error("Expected a booking form");
    expect(content.form.initialValues).toMatchObject({
      date,
      seats: expectedSeats,
      startTime,
      endTime,
    });
    expect(content.form.checkoutOfficeSelection).toEqual(hold.officeSelection);
    const preload = preloads.availabilityPreloads[0];
    expect(preload?.replacementToken).toBe("verified-pay-state");
    expect(preload?.queries.length).toBe(expectedSeats ? 1 : 0);
  }
);

test("keeps verified guests when the slot has ended and the checkout hold can still be replaced", async () => {
  const hold = verifiedHold(today.toString());
  const now = Temporal.Instant.from(hold.reservation.endsAt).add({
    minutes: 1,
  });
  const preloads = recordReservationPagePreloads();
  const clock = spyOn(Temporal.Now, "instant").mockReturnValue(now);
  const content = await Effect.runPromise(
    tableReservationPage
      .loadContent({
        checkoutAccount: { status: "signed-out" },
        locale,
        pageData: [4, 6],
        searchParams: {},
        restoredReservation: hold,
      })
      .pipe(Effect.provide(preloads.layer))
  ).finally(() => clock.mockRestore());

  expect(content.kind).toBe("form");
  if (content.kind !== "form") throw new Error("Expected a booking form");
  expect(content.form.initialValues).toMatchObject({
    date: today.toString(),
    startTime: "",
    endTime: "",
  });
  expect(content.form.checkoutSessionId).toEqual(hold.checkoutSessionId);
  expect(content.form.replacementToken).toBe(hold.replacementToken);
  expect(content.form.checkoutOfficeSelection).toEqual(hold.officeSelection);
});
