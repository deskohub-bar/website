import type { AudienceFilterOf } from "@deskohub/workspace-admin-api";
import {
  type AutomationFlowType as AutomationFlow,
  AutomationStep,
  AutomationTrigger,
} from "@deskohub/workspace-admin-api";
import { Schema } from "effect";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import type { AudienceFilterLeaf } from "../../audiences/audience-filter-editing";
import { emptyFlowSteps } from "./automation-flow-editing";

/**
 * The flow builder's form: the contract's trigger and steps, with no
 * trigger yet while an empty flow waits for one. The port checks the
 * flow's own rules, such as one send step, last, when it saves.
 */
export const createAutomationFlowFormSchema = (locale: Locale) =>
  Schema.Struct({
    trigger: Schema.NullOr(AutomationTrigger).check(
      Schema.makeFilter(
        (trigger) =>
          trigger !== null ||
          m.emailAutomationFlowTriggerRequired({}, { locale })
      )
    ),
    steps: Schema.Array(AutomationStep),
  });

type AutomationFlowFormSchema = ReturnType<
  typeof createAutomationFlowFormSchema
>;
export type AutomationFlowFormValues = AutomationFlowFormSchema["Encoded"];
export type AutomationFlowFormOutput = AutomationFlowFormSchema["Type"];

type StepEncoded = AutomationFlowFormValues["steps"][number];

/**
 * One step as the form holds it. A condition step's saved-audience
 * membership may have no audience picked yet, which only submission rejects.
 */
export type FlowStepValue =
  | Exclude<StepEncoded, { readonly _tag: "Condition" }>
  | (Omit<Extract<StepEncoded, { readonly _tag: "Condition" }>, "filter"> & {
      readonly filter: AudienceFilterOf<AudienceFilterLeaf>;
    });

/** The flow builder's values while the operator edits them. */
export type AutomationFlowDraftValues = Omit<
  AutomationFlowFormValues,
  "steps"
> & { readonly steps: readonly FlowStepValue[] };

/** The trigger as the form holds it, once chosen. */
export type FlowTriggerValue = NonNullable<AutomationFlowFormValues["trigger"]>;

/** The form values of a saved flow, or of an empty one. */
export const automationFlowFormValues = (
  flow: AutomationFlow | null
): AutomationFlowFormValues =>
  flow === null
    ? { trigger: null, steps: emptyFlowSteps }
    : { trigger: flow.trigger, steps: flow.steps };
