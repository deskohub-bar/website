import { describe, expect, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  type DotyposTable,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { Effect } from "effect";
import {
  isDisplayableWorkspaceTable,
  isWorkspaceCoworkHistoricalTableCandidate,
  isWorkspaceCoworkTableCandidate,
  selectOpenSpaceTableFromCandidates,
  selectWorkspaceTableFromCandidates as selectWorkspaceTableFromCandidatesEffect,
} from "./workspace-table-selection";

const selectWorkspaceTableFromCandidates = (
  ...args: Parameters<typeof selectWorkspaceTableFromCandidatesEffect>
) => Effect.runSync(selectWorkspaceTableFromCandidatesEffect(...args));

const selectionFailure = (
  ...args: Parameters<typeof selectWorkspaceTableFromCandidatesEffect>
) =>
  Effect.runSync(
    Effect.flip(selectWorkspaceTableFromCandidatesEffect(...args))
  );

const makeTable = (input: {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
  readonly seats?: string | undefined;
  readonly positionX?: string;
  readonly positionY?: string;
  readonly locationName?: string;
}): DotyposTable => ({
  _cloudId: DotyposCloudIdSchema.make("cloud"),
  display: true,
  enabled: true,
  seats: "1",
  ...input,
  id: DotyposTableIdSchema.make(input.id),
  tags: [...(input.tags ?? ["tier:basic"])],
});

describe("selectWorkspaceTableFromCandidates", () => {
  test("recognizes table tags for every reservation family", () => {
    for (const [id, tags] of [
      ["cowork", ["tier:basic"]],
      ["meeting-room", ["reservation:meeting-room"]],
      ["office", ["reservation:office"]],
      ["team-table", ["reservation:table"]],
    ] as const) {
      expect(
        isDisplayableWorkspaceTable(makeTable({ id, name: id, tags }))
      ).toBe(true);
    }

    expect(
      isDisplayableWorkspaceTable(
        makeTable({ id: "event", name: "Event", tags: ["reservation:event"] })
      )
    ).toBe(false);
  });

  test("selects the candidate with the strongest normalized distance score", () => {
    const occupied = makeTable({
      id: "occupied",
      name: "1",
      positionX: "0",
      positionY: "0",
    });
    const halfway = makeTable({
      id: "halfway",
      name: "2",
      positionX: "5",
      positionY: "0",
    });
    const far = makeTable({
      id: "far",
      name: "3",
      positionX: "10",
      positionY: "0",
    });
    const tables = [occupied, halfway, far];
    const occupancyByTableId = new Map([[occupied.id, 1]]);

    expect(
      selectWorkspaceTableFromCandidates(tables, tables, occupancyByTableId)?.id
    ).toBe("far");
  });

  test("penalizes candidate occupancy", () => {
    const reference = makeTable({
      id: "reference",
      name: "1",
      positionX: "0",
      positionY: "0",
    });
    const lightlyOccupied = makeTable({
      id: "lightly-occupied",
      name: "2",
      seats: "2",
      positionX: "10",
      positionY: "0",
    });
    const heavilyOccupied = makeTable({
      id: "heavily-occupied",
      name: "3",
      seats: "3",
      positionX: "10",
      positionY: "0",
    });
    const tables = [reference, lightlyOccupied, heavilyOccupied];
    const occupancyByTableId = new Map([
      [reference.id, 1],
      [lightlyOccupied.id, 1],
      [heavilyOccupied.id, 2],
    ]);

    expect(
      selectWorkspaceTableFromCandidates(tables, tables, occupancyByTableId)?.id
    ).toBe("lightly-occupied");
  });

  test("selects an unoccupied table above an occupied table", () => {
    const occupiedReference = makeTable({
      id: "occupied-reference",
      name: "1",
      positionX: "0",
      positionY: "0",
    });
    const nearestUnoccupied = makeTable({
      id: "nearest-unoccupied",
      name: "2",
      positionX: "0",
      positionY: "0",
    });
    const distantOccupied = makeTable({
      id: "distant-occupied",
      name: "3",
      seats: "2",
      positionX: "10",
      positionY: "0",
    });
    const tables = [occupiedReference, nearestUnoccupied, distantOccupied];
    const occupancyByTableId = new Map([
      [occupiedReference.id, 1],
      [distantOccupied.id, 1],
    ]);

    expect(
      selectWorkspaceTableFromCandidates(tables, tables, occupancyByTableId)?.id
    ).toBe("nearest-unoccupied");
  });

  test("rejects eligible tables with invalid seats", () => {
    const cases = [
      { seats: undefined, label: "missing seats" },
      { seats: "not-a-number", label: "non-numeric seats" },
      { seats: "0", label: "zero seats" },
      { seats: "-1", label: "negative seats" },
    ];

    for (const { seats, label } of cases) {
      const invalid = makeTable({ id: label, name: "1", seats });
      const valid = makeTable({ id: `valid-${label}`, name: "2" });

      expect(selectionFailure([invalid], [invalid], new Map())).toMatchObject({
        _tag: "InvalidDotyposTableSeats",
        tableId: label,
      });
      expect(
        selectionFailure([invalid, valid], [invalid, valid], new Map())
      ).toMatchObject({ _tag: "InvalidDotyposTableSeats", tableId: label });
    }
  });

  test("requires both an empty exclusive table and enough seats", () => {
    const office = makeTable({ id: "office", name: "Office", seats: "2" });

    expect(
      selectWorkspaceTableFromCandidates([office], [office], new Map(), 3, true)
    ).toBeUndefined();
    expect(
      selectWorkspaceTableFromCandidates(
        [office],
        [office],
        new Map([[office.id, 1]]),
        2,
        true
      )
    ).toBeUndefined();
    expect(
      selectWorkspaceTableFromCandidates([office], [office], new Map(), 2, true)
        ?.id
    ).toBe("office");
  });

  test("uses natural table order as the tie-breaker", () => {
    const tables = [
      makeTable({ id: "basic-10", name: "10" }),
      makeTable({ id: "basic-b", name: "2" }),
      makeTable({ id: "basic-a", name: "2" }),
    ];

    expect(
      selectWorkspaceTableFromCandidates(tables, tables, new Map())?.id
    ).toBe("basic-a");
  });

  test("scores against same-room occupied workspace tables that are not candidates", () => {
    const occupiedNonCandidate = makeTable({
      id: "occupied-plus",
      name: "1",
      tags: ["tier:plus"],
      positionX: "0",
      positionY: "0",
      locationName: "main",
    });
    const nearCandidate = makeTable({
      id: "near-basic",
      name: "2",
      positionX: "1",
      positionY: "0",
      locationName: "main",
    });
    const farCandidate = makeTable({
      id: "far-basic",
      name: "3",
      positionX: "10",
      positionY: "0",
      locationName: "main",
    });

    expect(
      selectWorkspaceTableFromCandidates(
        [nearCandidate, farCandidate],
        [occupiedNonCandidate, nearCandidate, farCandidate],
        new Map([[occupiedNonCandidate.id, 1]])
      )?.id
    ).toBe("far-basic");
  });

  test("ignores occupied workspace tables in a different room", () => {
    const occupiedDifferentRoom = makeTable({
      id: "occupied-plus",
      name: "1",
      tags: ["tier:plus"],
      positionX: "0",
      positionY: "0",
      locationName: "side-room",
    });
    const firstCandidate = makeTable({
      id: "first-basic",
      name: "2",
      positionX: "1",
      positionY: "0",
      locationName: "main",
    });
    const farCandidate = makeTable({
      id: "far-basic",
      name: "3",
      positionX: "10",
      positionY: "0",
      locationName: "main",
    });

    expect(
      selectWorkspaceTableFromCandidates(
        [firstCandidate, farCandidate],
        [occupiedDifferentRoom, firstCandidate, farCandidate],
        new Map([[occupiedDifferentRoom.id, 1]])
      )?.id
    ).toBe("first-basic");
  });
});

test("assigns solo Open Space to ordinary tables, then occupied Team Tables", () => {
  const reference = makeTable({
    id: "reference",
    name: "Reference",
    positionX: "0",
  });
  const near = makeTable({ id: "near", name: "Near", positionX: "1" });
  const far = makeTable({ id: "far", name: "Far", positionX: "4" });
  const occupied = makeTable({
    id: "occupied",
    name: "Occupied",
    positionX: "0",
    seats: "2",
    tags: ["cowork:open-space", "reservation:table"],
  });
  const empty = makeTable({
    id: "empty",
    name: "Empty",
    positionX: "10",
    tags: ["cowork:open-space", "reservation:table"],
  });
  const tables = [reference, near, far, occupied, empty];
  const occupancy = new Map([
    [reference.id, 1],
    [occupied.id, 1],
  ]);

  expect(
    Effect.runSync(
      selectOpenSpaceTableFromCandidates(tables, tables, occupancy)
    )?.id
  ).toBe(far.id);
  expect(
    Effect.runSync(
      selectOpenSpaceTableFromCandidates([empty, occupied], tables, occupancy)
    )?.id
  ).toBe(occupied.id);
  expect(
    Effect.runSync(
      selectOpenSpaceTableFromCandidates(
        [empty, occupied],
        tables,
        new Map([[occupied.id, 2]])
      )
    )?.id
  ).toBe(empty.id);
});

describe("shared cowork offer table candidate predicate", () => {
  const tags = (table: DotyposTable) => new Set(table.tags ?? []);

  const openSpaceTable = makeTable({
    id: "os-1",
    name: "OS1",
    tags: ["cowork:open-space"],
  });
  const openSpaceWithMonitor = makeTable({
    id: "os-2",
    name: "OS2",
    tags: ["cowork:open-space", "monitor:size:27"],
  });
  const reservedDeskPlain = makeTable({
    id: "rd-1",
    name: "RD1",
    tags: ["cowork:reserved-desk"],
  });
  const reservedDeskPartial = makeTable({
    id: "rd-2",
    name: "RD2",
    tags: ["cowork:reserved-desk", "monitor:count:2", "monitor:size:27"],
  });
  const reservedDeskFullQhd = makeTable({
    id: "rd-3",
    name: "RD3",
    tags: [
      "cowork:reserved-desk",
      "monitor:count:2",
      "monitor:size:27",
      "monitor:resolution:qhd",
    ],
  });

  test("open-space requires the label and excludes monitor-tagged tables", () => {
    expect(
      isWorkspaceCoworkTableCandidate(tags(openSpaceTable), {
        entryTier: "open-space",
      })
    ).toBe(true);
    expect(
      isWorkspaceCoworkTableCandidate(tags(openSpaceWithMonitor), {
        entryTier: "open-space",
      })
    ).toBe(false);
    expect(
      isWorkspaceCoworkTableCandidate(tags(reservedDeskPlain), {
        entryTier: "open-space",
      })
    ).toBe(false);
  });

  test("reserved-desk without addon excludes monitor-tagged tables", () => {
    expect(
      isWorkspaceCoworkTableCandidate(tags(reservedDeskPlain), {
        entryTier: "reserved-desk",
      })
    ).toBe(true);
    expect(
      isWorkspaceCoworkTableCandidate(tags(reservedDeskFullQhd), {
        entryTier: "reserved-desk",
      })
    ).toBe(false);
  });

  test("reserved-desk workstation addon requires the FULL configuration (fail closed)", () => {
    expect(
      isWorkspaceCoworkTableCandidate(tags(reservedDeskPartial), {
        entryTier: "reserved-desk",
        monitorOption: "2x27-qhd",
      })
    ).toBe(false);
    expect(
      isWorkspaceCoworkTableCandidate(tags(reservedDeskFullQhd), {
        entryTier: "reserved-desk",
        monitorOption: "2x27-qhd",
      })
    ).toBe(true);
    expect(
      isWorkspaceCoworkTableCandidate(tags(reservedDeskFullQhd), {
        entryTier: "reserved-desk",
        monitorOption: "2x27-4k",
      })
    ).toBe(false);
  });

  test("configured addon rejects extra or unknown monitor tags (exact set)", () => {
    expect(
      isWorkspaceCoworkTableCandidate(
        tags({
          ...reservedDeskFullQhd,
          tags: [...(reservedDeskFullQhd.tags ?? []), "monitor:xyz"],
        }),
        { entryTier: "reserved-desk", monitorOption: "2x27-qhd" }
      )
    ).toBe(false);
    expect(
      isWorkspaceCoworkTableCandidate(
        tags({
          ...reservedDeskFullQhd,
          tags: ["cowork:reserved-desk", "monitor:count:2", "monitor:xyz"],
        }),
        { entryTier: "reserved-desk", monitorOption: "2x27-qhd" }
      )
    ).toBe(false);
    const contradictoryResolution = tags({
      ...reservedDeskFullQhd,
      tags: [
        "cowork:reserved-desk",
        "monitor:count:2",
        "monitor:size:27",
        "monitor:resolution:qhd",
        "monitor:resolution:4k",
      ],
    });
    expect(
      isWorkspaceCoworkTableCandidate(contradictoryResolution, {
        entryTier: "reserved-desk",
        monitorOption: "2x27-qhd",
      })
    ).toBe(false);
    expect(
      isWorkspaceCoworkTableCandidate(contradictoryResolution, {
        entryTier: "reserved-desk",
        monitorOption: "2x27-4k",
      })
    ).toBe(false);
  });

  test("historical tiers keep their tier-tag predicate and never match offer labels", () => {
    expect(
      isWorkspaceCoworkHistoricalTableCandidate(tags(openSpaceTable), "basic")
    ).toBe(false);
    const legacy = new Set(["tier:basic"]);
    expect(isWorkspaceCoworkHistoricalTableCandidate(legacy, "basic")).toBe(
      true
    );
  });
});
