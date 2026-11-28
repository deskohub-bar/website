import { describe, expect, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  type DotyposTable,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { getWorkspaceTableMap } from "./workspace-table-map";

const makeTable = ({
  id,
  ...fields
}: Partial<Omit<DotyposTable, "id">> & {
  readonly id: string;
  readonly name: string;
}): DotyposTable => ({
  id: DotyposTableIdSchema.make(id),
  _cloudId: DotyposCloudIdSchema.make("cloud"),
  display: true,
  enabled: true,
  locationName: "main",
  tags: ["tier:basic"],
  ...fields,
});

describe("getWorkspaceTableMap", () => {
  test("returns only displayable workspace tables from the assigned room", () => {
    const tableMap = getWorkspaceTableMap(
      { _tableId: DotyposTableIdSchema.make("assigned") },
      [
        makeTable({ id: "assigned", name: "1" }),
        makeTable({ id: "plus", name: "2", tags: ["tier:plus"] }),
        makeTable({ id: "hidden", name: "3", display: false }),
        makeTable({ id: "disabled", name: "4", enabled: false }),
        makeTable({ id: "virtual", name: "5", tags: ["not-workspace"] }),
        makeTable({ id: "other-room", name: "6", locationName: "side" }),
      ]
    );

    expect(tableMap?.tables.map((table) => table.id)).toEqual([
      "assigned",
      "plus",
    ]);
  });
});
