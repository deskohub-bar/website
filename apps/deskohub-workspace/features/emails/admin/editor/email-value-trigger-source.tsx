"use client";

import {
  type EmailTriggerEvent,
  emailTriggerEvents,
  emailTriggerFields,
  isEmailTriggerEvent,
} from "@deskohub/workspace-admin-api";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import type { EmailDraftValueSource } from "./email-draft-form";
import {
  EmailFieldProblems,
  useEmailFieldProblems,
} from "./email-editor-context";
import { emailEditorFieldIds } from "./email-editor-field-ids";

const triggerLabels = {
  "entry-pack-expiring": m.emailsEditorValuesTriggerEntryPackExpiring,
  "unlimited-ending": m.emailsEditorValuesTriggerUnlimitedEnding,
} as const satisfies Record<
  EmailTriggerEvent,
  typeof m.emailsEditorValuesTriggerEntryPackExpiring
>;

const triggerFieldLabels: Readonly<
  Record<string, typeof m.emailsEditorTriggerFieldTier>
> = {
  firstName: m.emailsEditorTriggerFieldFirstName,
  tier: m.emailsEditorTriggerFieldTier,
  endsOn: m.emailsEditorTriggerFieldEndsOn,
  remainingEntries: m.emailsEditorTriggerFieldRemainingEntries,
  totalEntries: m.emailsEditorTriggerFieldTotalEntries,
  renewalStartsOn: m.emailsEditorTriggerFieldRenewalStartsOn,
  deskLabel: m.emailsEditorTriggerFieldDeskLabel,
  actionUrl: m.emailsEditorTriggerFieldActionUrl,
};

export const emailTriggerFieldLabel = (
  fieldName: string,
  locale: Locale
): string | undefined => triggerFieldLabels[fieldName]?.({}, { locale });

/** Selects which automation trigger supplies this value's fields. */
export function EmailValueTriggerSource({
  index,
  name,
  onChange,
  source,
}: {
  readonly index: number;
  readonly name: string | undefined;
  readonly onChange: (next: EmailDraftValueSource) => void;
  readonly source: EmailDraftValueSource;
}) {
  const locale = useRouteLocale();
  const fieldId = emailEditorFieldIds.valueSetting(index, "trigger");
  const problems = useEmailFieldProblems(fieldId);
  const trigger = isEmailTriggerEvent(source.trigger)
    ? source.trigger
    : undefined;
  const fields = trigger ? emailTriggerFields(trigger) : [];

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>
          {m.emailsEditorValuesTriggerLabel({}, { locale })}
        </Label>
        <Select
          onValueChange={(value) =>
            onChange({ kind: "trigger", trigger: value })
          }
          value={trigger ?? ""}
        >
          <SelectTrigger
            id={fieldId}
            className="max-w-md"
            {...problems.controlProps}
          >
            <SelectValue
              placeholder={m.emailsEditorValuesTriggerChoose({}, { locale })}
            />
          </SelectTrigger>
          <SelectContent>
            {emailTriggerEvents.map((event) => (
              <SelectItem key={event} value={event}>
                {triggerLabels[event]({}, { locale })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <EmailFieldProblems fieldId={fieldId} />
      </div>
      {fields.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-medium text-navy-blue/70 text-xs">
            {m.emailsEditorValuesTriggerFieldsHeading({}, { locale })}
          </p>
          <ul className="grid gap-1 text-xs sm:grid-cols-2">
            {fields.map((field) => (
              <li
                key={field.name}
                className="flex items-baseline gap-2 rounded-md bg-navy-blue/[0.03] px-2.5 py-1.5"
              >
                <code className="shrink-0 font-mono text-navy-blue">
                  {name ? `${name}.${field.name}` : field.name}
                </code>
                <span className="min-w-0 truncate text-navy-blue/65">
                  {emailTriggerFieldLabel(field.name, locale) ?? field.name}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
