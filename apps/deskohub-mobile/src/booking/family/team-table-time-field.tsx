import { useState } from "react";
import type { AppLocale } from "../../i18n/app-locale";
import { m } from "../../i18n/messages";
import { BottomSheet } from "../../ui/bottom-sheet";
import { ListGroup, ListRow } from "../../ui/list";
import { SelectField } from "../../ui/select-field";
import { formatPragueTime } from "../ui/prague-date-format";

export function TeamTableTimeField({
  label,
  times,
  startTime,
  selected,
  locale,
  onSelect,
}: {
  readonly label: string;
  readonly times: ReadonlyArray<string>;
  /** For an end field, the start it follows. */
  readonly startTime?: string | undefined;
  readonly selected?: string | undefined;
  readonly locale: AppLocale;
  readonly onSelect: (time: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const timeLabel = (value: string) => {
    const time = formatPragueTime(value, locale);
    return startTime !== undefined && value <= startTime
      ? m.booking_team_table_next_day({ time }, { locale })
      : time;
  };
  const disabled = times.length === 0;
  return (
    <>
      <SelectField
        label={label}
        disabled={disabled}
        value={
          selected !== undefined && times.includes(selected)
            ? timeLabel(selected)
            : undefined
        }
        onPress={() => setOpen(true)}
      />
      <BottomSheet
        visible={open && !disabled}
        title={label}
        onDismiss={() => setOpen(false)}
      >
        <ListGroup>
          {times.map((time) => (
            <ListRow
              key={time}
              label={timeLabel(time)}
              kind="action"
              selected={time === selected}
              onPress={() => {
                setOpen(false);
                onSelect(time);
              }}
            />
          ))}
        </ListGroup>
      </BottomSheet>
    </>
  );
}
