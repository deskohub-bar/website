"use client";

import { ComboboxGroup, ComboboxGroupLabel } from "@ui-sdk/react/combobox";
import type { ReactElement } from "react";
import { m } from "@/features/administration/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Badge } from "@/shared/components/ui/badge";
import {
  SearchablePicker,
  SearchablePickerItem,
} from "@/shared/components/ui/searchable-picker";
import { emailValueKindLabel } from "./email-value-kind-label";
import {
  type EmailCustomerFieldOption,
  type EmailCustomerFieldPath,
  emailCustomerFieldOptions,
  emailCustomerFieldPathLabel,
} from "./email-value-options";

const groups = [
  { kind: "scalar", heading: m.emailsEditorValuesGroupScalar },
  { kind: "record", heading: m.emailsEditorValuesGroupRecord },
  { kind: "list", heading: m.emailsEditorValuesGroupList },
] as const satisfies readonly {
  readonly kind: EmailCustomerFieldOption["kind"];
  readonly heading: typeof m.emailsEditorValuesGroupList;
}[];

/** Each kind's fields by path, so related fields sit together in order. */
const fieldsOfKind = (kind: EmailCustomerFieldOption["kind"]) =>
  emailCustomerFieldOptions
    .filter((option) => option.kind === kind)
    .map(({ path }) => ({ path, label: emailCustomerFieldPathLabel(path) }))
    .sort((left, right) => left.label.localeCompare(right.label, "en"));

const fieldsByKind = {
  scalar: fieldsOfKind("scalar"),
  record: fieldsOfKind("record"),
  list: fieldsOfKind("list"),
} as const;

/** Customer fields grouped by the kind of value they yield. */
export function EmailValueCustomerPicker({
  onSelect,
  restoresFocusOnSelect = true,
  selectedPath,
  trigger,
  triggerRole,
}: {
  readonly onSelect: (path: EmailCustomerFieldPath) => void;
  /** Turn this off when choosing a field moves focus to its settings. */
  readonly restoresFocusOnSelect?: boolean;
  readonly selectedPath?: EmailCustomerFieldPath;
  readonly trigger: ReactElement;
  readonly triggerRole?: "combobox";
}) {
  const locale = useRouteLocale();
  return (
    <SearchablePicker
      className="w-[min(26rem,calc(100vw-2rem))]"
      empty={m.emailsEditorValuesPickerEmpty({}, { locale })}
      focusOnSelect={restoresFocusOnSelect ? undefined : false}
      onPick={(label) => {
        const field = Object.values(fieldsByKind)
          .flat()
          .find((field) => field.label === label);
        if (field) onSelect(field.path);
      }}
      search={m.emailsEditorValuesPickerSearch({}, { locale })}
      trigger={trigger}
      triggerRole={triggerRole}
      value={selectedPath && emailCustomerFieldPathLabel(selectedPath)}
    >
      {groups.map(({ kind, heading }) => (
        <ComboboxGroup key={kind}>
          <ComboboxGroupLabel className="px-2 pt-2 pb-1 font-semibold text-navy-blue/55 text-xs uppercase tracking-[0.08em]">
            {heading({}, { locale })}
          </ComboboxGroupLabel>
          {fieldsByKind[kind].map(({ label }) => (
            <SearchablePickerItem key={label} label={label} value={label}>
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {label}
              </code>
              <Badge
                className="shrink-0 px-1.5 py-0 text-[11px]"
                variant="subtle"
              >
                {emailValueKindLabel(kind, locale)}
              </Badge>
            </SearchablePickerItem>
          ))}
        </ComboboxGroup>
      ))}
    </SearchablePicker>
  );
}
