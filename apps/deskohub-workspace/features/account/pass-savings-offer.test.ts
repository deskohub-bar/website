import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import { orderIdSchema } from "@/features/order";
import type { AccountEntryPack, AccountPasses } from "./account-passes.server";
import type {
  AccountUnlimitedPass,
  AccountUnlimitedPasses,
} from "./account-unlimited-passes.server";
import {
  type CustomerReservationSummary,
  groupCustomerReservations,
} from "./contracts";
import { offersPassSavings } from "./pass-savings-offer";

const now = Temporal.Instant.from("2026-11-22T12:00:00Z");

const visit = (
  overrides: Partial<CustomerReservationSummary> = {}
): CustomerReservationSummary => ({
  id: crypto.randomUUID(),
  product: { kind: "cowork", tier: "open-space" },
  startsAt: "2026-11-10T08:00:00Z",
  endsAt: "2026-11-10T16:00:00Z",
  seats: 1,
  status: "confirmed",
  settlement: "paid",
  ...overrides,
});

const entryPack = (
  overrides: Partial<AccountEntryPack> = {}
): AccountEntryPack => ({
  position: 1,
  tier: "Basic",
  entryCount: 5,
  entriesLeft: 3,
  lastUsableDay: "Feb 1, 2027",
  status: "active",
  ...overrides,
});

const unlimitedPass = (
  status: AccountUnlimitedPass["status"]
): AccountUnlimitedPass => {
  const shared = {
    orderId: orderIdSchema.make(crypto.randomUUID()),
    tier: "Basic",
    boughtForYou: false,
    period: "Nov 10 – Dec 9, 2026",
    seating: { kind: "shared" },
  } as const;
  switch (status) {
    case "upcoming":
      return { ...shared, status, startsOn: "Dec 10, 2026" };
    case "active":
      return {
        ...shared,
        status,
        day: 3,
        totalDays: 30,
        daysLeft: 28,
        accessPath: "/en-US/reservation/access/fixture",
      };
    case "expired":
    case "ended":
      return { ...shared, status };
  }
};

const offers = ({
  reservations,
  entryPacks = { held: [], boughtForOthers: [] },
  unlimitedPasses = [],
}: {
  readonly reservations: readonly CustomerReservationSummary[];
  readonly entryPacks?: AccountPasses;
  readonly unlimitedPasses?: AccountUnlimitedPasses;
}) =>
  offersPassSavings({
    past: groupCustomerReservations(reservations, now).past,
    entryPacks,
    unlimitedPasses,
  });

describe("offersPassSavings", () => {
  test("offers packs and passes after a completed visit paid on its own", () => {
    expect(offers({ reservations: [visit()] })).toBe(true);
    expect(
      offers({
        reservations: [visit()],
        entryPacks: {
          held: [
            entryPack({ status: "depleted", entriesLeft: 0 }),
            entryPack({ status: "expired" }),
            entryPack({ status: "active", entriesLeft: 0 }),
            // Active with entries left, but not usable yet: an unclaimed
            // gift, or a gift whose payment can't be used.
            entryPack(),
          ],
          boughtForOthers: [],
        },
        unlimitedPasses: [unlimitedPass("expired"), unlimitedPass("ended")],
      })
    ).toBe(true);
  });

  test("needs a past confirmed cowork visit of the customer's own paid with money", () => {
    const notIndividuallyPaid: CustomerReservationSummary[] = [
      // Settled free or from an Entry pack, or not settled at all, such as a
      // refunded order or a booking with no website order.
      visit({ settlement: "free" }),
      visit({ settlement: "entry-pack" }),
      visit({ settlement: undefined }),
    ];
    const cases = {
      "no reservations": [],
      "not individually paid": notIndividuallyPaid,
      cancelled: [visit({ status: "cancelled" })],
      pending: [visit({ status: "pending" })],
      "future only": [
        visit({
          startsAt: "2026-11-30T08:00:00Z",
          endsAt: "2026-11-30T16:00:00Z",
        }),
      ],
      "still running": [
        visit({
          startsAt: "2026-11-22T08:00:00Z",
          endsAt: "2026-11-22T16:00:00Z",
        }),
      ],
      "another product": [visit({ product: { kind: "meeting-room" } })],
      "booked for another customer": [
        visit({ party: { kind: "booked-for", customerName: null } }),
      ],
    } satisfies Record<string, readonly CustomerReservationSummary[]>;

    for (const [name, reservations] of Object.entries(cases)) {
      expect({ name, offered: offers({ reservations }) }).toEqual({
        name,
        offered: false,
      });
    }
  });

  test("counts a paid visit another account booked for the customer", () => {
    for (const party of [
      { kind: "booked-by", authorName: null },
      { kind: "booked-by-deleted-account" },
    ] as const) {
      expect(offers({ reservations: [visit({ party })] })).toBe(true);
    }
  });

  test("ends a visit exactly at now as completed", () => {
    expect(
      offers({
        reservations: [
          visit({
            startsAt: "2026-11-22T04:00:00Z",
            endsAt: now.toString(),
          }),
        ],
      })
    ).toBe(true);
  });

  test("hides the offer while the customer holds coverage", () => {
    const coverage = {
      "usable Entry pack": {
        entryPacks: {
          held: [entryPack({ bookPath: "/en-US/passes/entry-pack/book" })],
          boughtForOthers: [],
        },
      },
      "active Unlimited pass": { unlimitedPasses: [unlimitedPass("active")] },
      "upcoming Unlimited pass": {
        unlimitedPasses: [unlimitedPass("upcoming")],
      },
    } satisfies Record<
      string,
      {
        readonly entryPacks?: AccountPasses;
        readonly unlimitedPasses?: AccountUnlimitedPasses;
      }
    >;

    for (const [name, held] of Object.entries(coverage)) {
      expect({
        name,
        offered: offers({ reservations: [visit()], ...held }),
      }).toEqual({ name, offered: false });
    }
  });

  test("keeps the offer hidden while coverage can't be read", () => {
    expect(offers({ reservations: [visit()], entryPacks: "unavailable" })).toBe(
      false
    );
    expect(
      offers({ reservations: [visit()], unlimitedPasses: "unavailable" })
    ).toBe(false);
  });
});
