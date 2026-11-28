import { expect, test } from "bun:test";
import type { CustomerHeldEntryPack } from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import { keptCoworkEntryChoice } from "../booking/family/cowork-booking-model";
import {
  type CoworkDraft,
  selectCoworkWorkstation,
} from "../booking/selection/cowork-selection";
import {
  entryPackDates,
  openEntryPackDraft,
  packCoversDraft,
} from "./entry-pack-booking";
import { entryPackHrefForDraft } from "./pass-routes";

const pack = {
  kind: "entry-pack",
  tier: "reserved-desk-workstation",
  status: "active",
  size: 5,
  passId: "642ef6b9-48aa-495f-83a8-9a53f4791692",
  entriesLeft: 3,
  validFrom: "2026-11-21",
  lastUsableDate: "2027-01-31",
  bookFrom: "2026-11-21",
  bookedDates: ["2026-11-27"],
} satisfies CustomerHeldEntryPack;

const previous: CoworkDraft = {
  tier: "open-space",
  stay: "day",
  coffee: true,
  date: Option.some("2027-03-01"),
  workstation: Option.none(),
};

test("the holder link selects the pack's desk tier and starts with an open date choice", () => {
  const draft = openEntryPackDraft(previous, pack);
  expect(draft.tier).toBe("reserved-desk");
  expect(draft.date).toEqual(Option.none());
  expect(draft.coffee).toBe(false);
  expect(packCoversDraft(pack, draft)).toBe(false);
  expect(
    packCoversDraft(
      pack,
      selectCoworkWorkstation(draft, Option.some("2x27-qhd"))
    )
  ).toBe(true);
});

test("the pass calendar intersects the booking window and keeps sold-out and claimed days unavailable", () => {
  const dates = entryPackDates(
    {
      earliest: "2026-11-19",
      latest: "2027-02-12",
      unavailable: new Set(["2026-11-29"]),
    },
    pack,
    [...pack.bookedDates, "2026-11-28"]
  );
  expect(dates).toEqual({
    earliest: "2026-11-21",
    latest: "2027-01-31",
    unavailable: new Set(["2026-11-29", "2026-11-27", "2026-11-28"]),
  });
});

test("the buy link uses the current compatible choices, including clearing a workstation", () => {
  const draft = openEntryPackDraft(previous, pack);
  expect(
    entryPackHrefForDraft(
      selectCoworkWorkstation(draft, Option.some("2x27-qhd"))
    )
  ).toEqual({
    pathname: "/passes/entry-pack",
    params: { tier: "reserved-desk-workstation" },
  });
  expect(
    entryPackHrefForDraft(selectCoworkWorkstation(draft, Option.none())).params
  ).toEqual({
    tier: "reserved-desk",
  });
  expect(entryPackHrefForDraft(previous).params).toEqual({
    tier: "open-space",
  });
});

test("a regular Reserved Desk pack covers a required paid workstation and keeps voluntary upgrades uncovered", () => {
  const deskPack: CustomerHeldEntryPack = { ...pack, tier: "reserved-desk" };
  const draft = openEntryPackDraft(previous, deskPack);
  const workstation = selectCoworkWorkstation(draft, Option.some("2x27-qhd"));
  expect(packCoversDraft(deskPack, workstation)).toBe(false);
  expect(packCoversDraft(deskPack, workstation, true)).toBe(true);
});

test("a fresh Book route ignores the previous pack choice while Back and checkout restart keep it", () => {
  const kept = Option.some({
    seed: pack.passId,
    routeKey: "booking:1",
    draft: previous,
    entryPackId: pack.passId,
  });
  expect(keptCoworkEntryChoice(kept, "", "booking:2", false)).toEqual(
    Option.none()
  );
  expect(keptCoworkEntryChoice(kept, pack.passId, "booking:1", false)).toEqual(
    kept
  );
  expect(keptCoworkEntryChoice(kept, "", "booking:2", true)).toEqual(kept);
  expect(keptCoworkEntryChoice(kept, pack.passId, "booking:2", false)).toEqual(
    Option.none()
  );
});
