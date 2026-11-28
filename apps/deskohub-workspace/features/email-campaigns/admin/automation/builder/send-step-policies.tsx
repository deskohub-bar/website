"use client";

import { automationOneOffCampaignGapMaxDays } from "@deskohub/workspace-admin-api";
import { useId } from "react";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Input } from "@/shared/components/ui/input";
import { cn } from "@/shared/utils";
import {
  compactInputClassName,
  FieldError,
  type FieldErrorLookup,
  fieldErrorAttributes,
  numberFromInput,
  numberInputValue,
} from "../../audiences/audience-control-primitives";
import type { FlowStepValue } from "./automation-flow-form";

export type SendStep = Extract<FlowStepValue, { _tag: "Send" }>;

/** The gap a newly turned-on one-off campaign gap starts with. */
const defaultOneOffCampaignGapDays = 14;

/*
 * A turned-off rule drops its key, so a Send without rules keeps the exact
 * shape, and draft hash, it had before the rules existed.
 */

const withOncePerCustomer = (step: SendStep, on: boolean): SendStep => {
  const { oncePerCustomer: _, ...rest } = step;
  return on ? { ...rest, oncePerCustomer: true } : rest;
};

const withOneOffCampaignGap = (
  step: SendStep,
  days: number | null
): SendStep => {
  const { oneOffCampaignGap: _, ...rest } = step;
  return days === null ? rest : { ...rest, oneOffCampaignGap: { days } };
};

const withSkipPassHolders = (step: SendStep, on: boolean): SendStep => {
  const { skipPassHolders: _, ...rest } = step;
  return on ? { ...rest, skipPassHolders: true } : rest;
};

/** The step's rules as sentences, in the order the controls list them. */
const policySentences = (step: SendStep, locale: Locale) => {
  const sentences: string[] = [];
  if (step.oncePerCustomer) {
    sentences.push(
      m.emailAutomationFlowSendOncePerCustomerSummary({}, { locale })
    );
  }
  // Days still being typed have no sentence until they are a whole number.
  const gapDays = step.oneOffCampaignGap?.days;
  if (gapDays !== undefined && Number.isInteger(gapDays)) {
    sentences.push(
      m.emailAutomationFlowSendGapSummary({ count: gapDays }, { locale })
    );
  }
  if (step.skipPassHolders) {
    sentences.push(
      m.emailAutomationFlowSendSkipPassHoldersSummary({}, { locale })
    );
  }
  return sentences;
};

/**
 * What the Send step does besides sending: each active delivery rule as a
 * sentence, or that there are none.
 */
export function SendPolicySummary({ step }: { readonly step: SendStep }) {
  const locale = useRouteLocale();
  const sentences = policySentences(step, locale);
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-1.5">
      <h4
        id={titleId}
        className="font-semibold text-[0.7rem] text-navy-blue/55 uppercase tracking-[0.12em]"
      >
        {m.emailAutomationFlowSendPoliciesTitle({}, { locale })}
      </h4>
      {sentences.length === 0 ? (
        <p className="text-navy-blue/70 text-sm">
          {m.emailAutomationFlowSendPoliciesNone({}, { locale })}
        </p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {sentences.map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The delivery rules' switches, and the gap's length once it is on. Where
 * skipping pass holders isn't available, its switch shows only while on,
 * so it can be turned off.
 */
export function SendPolicyControls({
  step,
  skipPassHoldersAvailable = true,
  onChange,
  errorAt,
}: {
  readonly step: SendStep;
  /** False under a pass reminder trigger, whose recipients all hold a pass. */
  readonly skipPassHoldersAvailable?: boolean;
  readonly onChange: (step: SendStep) => void;
  /** Errors at paths below the step. */
  readonly errorAt: FieldErrorLookup;
}) {
  const locale = useRouteLocale();
  const ids = {
    once: useId(),
    gap: useId(),
    gapDays: useId(),
    gapDaysError: useId(),
    skip: useId(),
  };
  const gap = step.oneOffCampaignGap;
  const gapDaysError = errorAt("oneOffCampaignGap.days");
  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">
        {m.emailAutomationFlowSendPoliciesTitle({}, { locale })}
      </legend>
      <PolicyCheckbox
        id={ids.once}
        checked={step.oncePerCustomer === true}
        onCheckedChange={(on) => onChange(withOncePerCustomer(step, on))}
        label={m.emailAutomationFlowSendOncePerCustomerLabel({}, { locale })}
      />
      <div className="space-y-2">
        <PolicyCheckbox
          id={ids.gap}
          checked={gap !== undefined}
          onCheckedChange={(on) =>
            onChange(
              withOneOffCampaignGap(
                step,
                on ? defaultOneOffCampaignGapDays : null
              )
            )
          }
          label={m.emailAutomationFlowSendGapLabel({}, { locale })}
        />
        {gap !== undefined && (
          <div className="flex flex-col gap-1.5 pl-8">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={ids.gapDays} className="text-sm">
                {m.emailAutomationFlowSendGapDaysLabel({}, { locale })}
              </label>
              <Input
                id={ids.gapDays}
                type="number"
                inputMode="numeric"
                min={1}
                max={automationOneOffCampaignGapMaxDays}
                step={1}
                value={numberInputValue(gap.days)}
                onChange={(event) =>
                  onChange(
                    withOneOffCampaignGap(
                      step,
                      numberFromInput(event.target.value)
                    )
                  )
                }
                {...fieldErrorAttributes(
                  ids.gapDaysError,
                  gapDaysError !== undefined
                )}
                variant={gapDaysError ? "error" : "default"}
                className={cn(compactInputClassName, "w-24")}
              />
            </div>
            <FieldError
              id={ids.gapDaysError}
              messages={[
                gapDaysError &&
                  m.emailAutomationFlowSendGapDaysError(
                    { max: automationOneOffCampaignGapMaxDays },
                    { locale }
                  ),
              ]}
            />
          </div>
        )}
      </div>
      {(skipPassHoldersAvailable || step.skipPassHolders === true) && (
        <PolicyCheckbox
          id={ids.skip}
          checked={step.skipPassHolders === true}
          onCheckedChange={(on) => onChange(withSkipPassHolders(step, on))}
          label={m.emailAutomationFlowSendSkipPassHoldersLabel({}, { locale })}
        />
      )}
    </fieldset>
  );
}

function PolicyCheckbox({
  id,
  checked,
  onCheckedChange,
  label,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: string;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-3 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="size-5"
      />
      {label}
    </label>
  );
}
