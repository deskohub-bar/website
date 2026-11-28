import { expect, mock, test } from "bun:test";
import { m } from "../../i18n/messages";
import { BottomSheet } from "../../ui/bottom-sheet";
import { ListRow } from "../../ui/list";
import { SelectField } from "../../ui/select-field";
import { elementTree, find, findAll } from "../../ui/testing/element-tree";
import { formatPragueTime } from "../ui/prague-date-format";
import { TeamTableTimeField } from "./team-table-time-field";

const locale = "en-US";
const label = "End time";

test("the end time field is disabled until the selected start has available ends", () => {
  const tree = elementTree(TeamTableTimeField, {
    label,
    times: [],
    locale,
    selected: "00:00",
    onSelect: () => undefined,
  });
  expect(find(tree, SelectField)?.props).toMatchObject({
    disabled: true,
    value: undefined,
  });
  expect(findAll(find(tree, BottomSheet), ListRow)).toHaveLength(0);
});

test("the end time sheet labels next-day ends and returns the original time", () => {
  const onSelect = mock((_: string) => undefined);
  const tree = elementTree(TeamTableTimeField, {
    label,
    times: ["23:45", "00:00"],
    startTime: "23:30",
    selected: "00:00",
    locale,
    onSelect,
  });
  const nextDay = m.booking_team_table_next_day(
    { time: formatPragueTime("00:00", locale) },
    { locale }
  );
  expect(find(tree, SelectField)?.props.value).toBe(nextDay);
  const rows = findAll(find(tree, BottomSheet), ListRow);
  expect(
    rows.map(({ props }) => [props.kind, props.label, props.selected])
  ).toEqual([
    ["action", formatPragueTime("23:45", locale), false],
    ["action", nextDay, true],
  ]);
  rows[1]?.props.onPress?.();
  expect(onSelect).toHaveBeenCalledWith("00:00");
});
