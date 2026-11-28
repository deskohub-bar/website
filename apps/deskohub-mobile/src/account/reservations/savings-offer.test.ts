import { describe, expect, test } from "bun:test";
import type {
  CustomerHeldEntryPack,
  CustomerHeldUnlimitedPass,
  CustomerReservationOrderId,
} from "@deskohub/workspace-customer-api";
import type { ReservationListRow } from "./reservation-list-model";
import { type SavingsOfferFacts, showsSavingsOffer } from "./savings-offer";

const orderId = (id: string) => id as CustomerReservationOrderId;

const visit = (
  id: string,
  change: Partial<ReservationListRow> = {}
): ReservationListRow => ({
  id,
  orderId: orderId(id),
  product: { kind: "cowork", tier: "open-space" },
  startsAt: "2026-11-02T08:00:00Z",
  endsAt: "2026-11-02T16:00:00Z",
  seats: 1,
  status: "confirmed",
  settlement: "paid",
  ...change,
});

const entryPack = (
  change: Partial<CustomerHeldEntryPack> = {}
): CustomerHeldEntryPack => ({
  kind: "entry-pack",
  passId: "pack" as CustomerHeldEntryPack["passId"],
  tier: "open-space",
  size: 5,
  validFrom: "2026-10-01",
  lastUsableDate: "2027-01-31",
  entriesLeft: 3,
  status: "active",
  bookedDates: [],
  bookFrom: "2026-11-23",
  ...change,
});

const unlimited = (
  status: CustomerHeldUnlimitedPass["status"]
): CustomerHeldUnlimitedPass => ({
  kind: "unlimited",
  passId: "unlimited" as CustomerHeldUnlimitedPass["passId"],
  tier: "reserved-desk",
  validFrom: "2026-11-01",
  lastUsableDate: "2026-11-30",
  status,
});

const shows = (facts: Partial<SavingsOfferFacts> = {}) =>
  showsSavingsOffer({
    past: [visit("paid")],
    held: [],
    ...facts,
  });

describe("showsSavingsOffer", () => {
  test("a coworking visit paid individually, with no pass, shows the offer", () => {
    expect(shows()).toBe(true);
  });

  test("free, Entry pack, unsettled and unknown settlements don't count", () => {
    for (const settlement of ["free", "entry-pack", undefined, "voucher"]) {
      expect(shows({ past: [visit("v", { settlement })] })).toBe(false);
    }
    expect(
      shows({
        past: [
          visit("free", { settlement: "free" }),
          visit("later-value", { settlement: "voucher" }),
          visit("pack", { settlement: "entry-pack" }),
          visit("paid"),
        ],
      })
    ).toBe(true);
  });

  test("cancelled, pending and unpaid visits don't count", () => {
    for (const status of [
      "cancelled",
      "pending",
      "requires-attention",
    ] as const) {
      expect(shows({ past: [visit("v", { status })] })).toBe(false);
    }
  });

  test("visits booked for someone else don't count", () => {
    expect(
      shows({
        past: [
          visit("for", { party: { kind: "booked-for", customerName: null } }),
        ],
      })
    ).toBe(false);
  });

  test("visits another account booked for this one count", () => {
    expect(
      shows({
        past: [visit("by", { party: { kind: "booked-by", authorName: "A" } })],
      })
    ).toBe(true);
    expect(
      shows({
        past: [visit("by", { party: { kind: "booked-by-deleted-account" } })],
      })
    ).toBe(true);
  });

  test("meeting rooms and offices don't count", () => {
    expect(
      shows({
        past: [
          visit("room", { product: { kind: "meeting-room" } }),
          visit("office", { product: { kind: "office" } }),
        ],
      })
    ).toBe(false);
  });

  test("a visit without a settlement shows nothing about its payment", () => {
    // Dotypos-only, an order not paid, or a Workspace that sends none yet.
    expect(
      shows({
        past: [visit("dotypos", { orderId: undefined, settlement: undefined })],
      })
    ).toBe(false);
    expect(shows({ past: [visit("unpaid", { settlement: undefined })] })).toBe(
      false
    );
  });

  test("an Entry pack with entries left covers the next visits", () => {
    expect(shows({ held: [entryPack()] })).toBe(false);
  });

  test("a used-up, expired, ended or unbookable Entry pack doesn't", () => {
    expect(shows({ held: [entryPack({ entriesLeft: 0 })] })).toBe(true);
    // An unclaimed or unpaid gift, or no free date left: nothing to book.
    expect(shows({ held: [entryPack({ bookFrom: undefined })] })).toBe(true);
    for (const status of ["depleted", "expired", "ended"] as const) {
      expect(shows({ held: [entryPack({ status, entriesLeft: 2 })] })).toBe(
        true
      );
    }
  });

  test("an active or upcoming Unlimited pass covers the next visits", () => {
    expect(shows({ held: [unlimited("active")] })).toBe(false);
    expect(shows({ held: [unlimited("upcoming")] })).toBe(false);
  });

  test("an ended or expired Unlimited pass doesn't", () => {
    expect(shows({ held: [unlimited("ended"), unlimited("expired")] })).toBe(
      true
    );
  });

  test("nothing shows until the pass reads succeed", () => {
    // The pass rollout closed, or the held passes loading or failed.
    expect(shows({ held: undefined })).toBe(false);
  });

  test("an empty Past group shows nothing", () => {
    expect(shows({ past: [] })).toBe(false);
  });
});
