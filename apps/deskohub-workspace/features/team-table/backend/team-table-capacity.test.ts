import { expect, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  DotyposService,
  type DotyposTable,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { loadAdvisoryTeamTableSeatCapacities } from "./team-table-advisory-capacity";
import { getTeamTableSeatCapacities } from "./team-table-capacity";
import { loadTeamTableSeatCapacities } from "./team-table-capacity.server";

const makeTable = (
  id: string,
  overrides: Partial<DotyposTable> = {}
): DotyposTable => ({
  id: DotyposTableIdSchema.make(id),
  _cloudId: DotyposCloudIdSchema.make("cloud"),
  display: true,
  enabled: true,
  name: id,
  seats: "4",
  tags: ["reservation:table", "cowork:open-space"],
  ...overrides,
});

test("derives distinct sizes from enabled and visible Team Tables in Open Space", () => {
  const ignored = [
    makeTable("disabled", { enabled: false, seats: "invalid" }),
    makeTable("hidden", { display: false, seats: "invalid" }),
    makeTable("no-open-space", {
      tags: ["reservation:table"],
      seats: "invalid",
    }),
    makeTable("no-team-table", {
      tags: ["cowork:open-space"],
      seats: "invalid",
    }),
  ];

  expect(Effect.runSync(getTeamTableSeatCapacities(ignored))).toEqual([]);
  expect(
    Effect.runSync(
      getTeamTableSeatCapacities([
        makeTable("eight", { seats: "8" }),
        ...ignored,
        makeTable("four-a", { seats: "4.0" }),
        makeTable("four-b", { seats: "4e0" }),
      ])
    )
  ).toEqual([4, 8]);
});

test("fails discovery when any eligible table has an invalid size", () => {
  for (const seats of [
    "",
    "0",
    "-1",
    "1.5",
    "4.0000000000000001",
    "9007199254740992",
  ]) {
    expect(
      Effect.runSync(
        Effect.flip(
          getTeamTableSeatCapacities([
            makeTable("valid"),
            makeTable("invalid", { seats }),
          ])
        )
      )
    ).toMatchObject({ _tag: "InvalidDotyposTableSeats", tableId: "invalid" });
  }
});

test("uses live tables for checkout and the advisory snapshot for catalog reads", () => {
  const live = Layer.mock(DotyposService, {
    getTables: () => Effect.succeed([makeTable("live", { seats: "8" })]),
  });
  const advisory = Layer.mock(AdvisoryAvailabilityInventory, {
    tables: Effect.succeed([makeTable("snapshot", { seats: "6" })]),
  });

  expect(
    Effect.runSync(loadTeamTableSeatCapacities().pipe(Effect.provide(live)))
  ).toEqual([8]);
  expect(
    Effect.runSync(
      loadAdvisoryTeamTableSeatCapacities.pipe(Effect.provide(advisory))
    )
  ).toEqual([6]);
});
