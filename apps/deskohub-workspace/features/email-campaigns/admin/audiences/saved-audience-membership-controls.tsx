"use client";

import { AdministrationCampaignAudienceId } from "@deskohub/workspace-admin-api";
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { m } from "@/features/administration/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { fieldTriggerVariants } from "@/shared/components/ui/field-trigger";
import {
  SearchablePicker,
  SearchablePickerItem,
} from "@/shared/components/ui/searchable-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { cn } from "@/shared/utils";
import type { AudienceValueOption } from "../audience-filter-summary";
import {
  ConditionLine,
  type ControlProps,
  compactSelectClassName,
  FieldError,
  fieldErrorAttributes,
} from "./audience-control-primitives";
import {
  type SavedAudienceMembershipDraft,
  unchosenSavedAudience,
} from "./audience-filter-editing";

const membershipOperators = ["in", "notIn"] as const;

/**
 * "is (not) in saved audience <audience>", picked by name and searchable. A
 * chosen audience missing from the list, such as a deleted one, stays chosen
 * under its own label. The audience counts as it is defined when a run
 * reaches the step, which the note under the line says.
 */
export function SavedAudienceMembershipControls({
  value: condition,
  onChange,
  errorAt,
  savedAudiences,
}: ControlProps<SavedAudienceMembershipDraft> & {
  readonly savedAudiences: readonly AudienceValueOption[];
}) {
  const locale = useRouteLocale();
  const missing = errorAt("audienceId") !== undefined;
  const missingErrorId = useId();
  return (
    <div className="flex flex-col gap-2">
      <ConditionLine>
        <Select
          value={condition.operator}
          onValueChange={(next) => {
            const operator = membershipOperators.find(
              (known) => known === next
            );
            if (operator) onChange({ ...condition, operator });
          }}
        >
          <SelectTrigger
            aria-label={m.emailAutomationFlowSavedAudienceOperatorLabel(
              {},
              { locale }
            )}
            className={compactSelectClassName}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {membershipOperators.map((operator) => (
              <SelectItem key={operator} value={operator}>
                {m.emailAutomationFlowSavedAudienceOperator(
                  { operator },
                  { locale }
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SavedAudiencePicker
          condition={condition}
          onChange={onChange}
          savedAudiences={savedAudiences}
          missing={missing}
          missingErrorId={missingErrorId}
        />
      </ConditionLine>
      <p className="text-navy-blue/55 text-xs">
        {m.emailAutomationFlowSavedAudienceLiveNote({}, { locale })}
      </p>
      <FieldError
        id={missingErrorId}
        messages={[
          missing
            ? m.emailAutomationFlowSavedAudienceRequired({}, { locale })
            : undefined,
        ]}
      />
    </div>
  );
}

/** The searchable audience picker, marked invalid while none is chosen. */
function SavedAudiencePicker({
  condition,
  onChange,
  savedAudiences,
  missing,
  missingErrorId,
}: {
  readonly condition: SavedAudienceMembershipDraft;
  readonly onChange: (condition: SavedAudienceMembershipDraft) => void;
  readonly savedAudiences: readonly AudienceValueOption[];
  readonly missing: boolean;
  /** The id of the `FieldError` that says an audience is required. */
  readonly missingErrorId: string;
}) {
  const locale = useRouteLocale();
  const chosen =
    condition.audienceId === unchosenSavedAudience
      ? undefined
      : condition.audienceId;
  const chosenAudience = savedAudiences.find(({ id }) => id === chosen);
  const unknown = m.emailAutomationFlowSavedAudienceUnknown({}, { locale });
  return (
    <SearchablePicker
      empty={m.emailAutomationFlowSavedAudienceEmpty({}, { locale })}
      onPick={(audienceId) =>
        onChange({
          ...condition,
          audienceId: AdministrationCampaignAudienceId.make(audienceId),
        })
      }
      search={m.emailAutomationFlowSavedAudienceSearch({}, { locale })}
      value={chosen}
      triggerRole="combobox"
      trigger={
        <button
          type="button"
          {...fieldErrorAttributes(missingErrorId, missing)}
          aria-label={m.emailAutomationFlowSavedAudiencePickerLabel(
            {},
            { locale }
          )}
          className={cn(
            fieldTriggerVariants(),
            compactSelectClassName,
            "max-w-72 justify-between",
            missing && "border-burned-orange"
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate",
              chosen === undefined && "text-navy-blue/60"
            )}
          >
            {chosen === undefined
              ? m.emailAutomationFlowSavedAudiencePickerPlaceholder(
                  {},
                  { locale }
                )
              : (chosenAudience?.name ?? unknown)}
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-navy-blue/60"
            aria-hidden
          />
        </button>
      }
    >
      {chosen !== undefined && !chosenAudience && (
        <SearchablePickerItem label={unknown} value={chosen}>
          {unknown}
        </SearchablePickerItem>
      )}
      {savedAudiences.map((audience) => (
        <SearchablePickerItem
          key={audience.id}
          label={audience.name}
          value={audience.id}
        >
          <span className="min-w-0 flex-1 truncate">{audience.name}</span>
        </SearchablePickerItem>
      ))}
    </SearchablePicker>
  );
}
