import type {
  AutomationTriggerKindType as AutomationTriggerKind,
  CalendarExpressionType as CalendarExpression,
} from "@deskohub/workspace-admin-api";
import { Match, Struct } from "effect";
import { isPassReminderTrigger } from "../../../automation/automation-triggers";
import type {
  AutomationFlowFormValues,
  FlowStepValue as AutomationStep,
  FlowTriggerValue as AutomationTrigger,
} from "./automation-flow-form";

/**
 * The preview key of a schedule trigger's calendar. Wait steps' previews go
 * under their step ids, which can't contain `#`.
 */
export const triggerPreviewKey = "#trigger";

/** The steps an admin can insert; the send step is fixed and last. */
export type InsertableStepKind = Exclude<AutomationStep["_tag"], "Send">;

/** Event triggers, the tag a flow stores for each trigger kind. */
export const eventTriggerTags = {
  "reservation-booked": "ReservationBooked",
  "reservation-cancelled": "ReservationCancelled",
  "reservation-started": "ReservationStarted",
  "reservation-finished": "ReservationFinished",
  "account-created": "AccountCreated",
  "entry-pack-expiring": "EntryPackExpiring",
  "unlimited-ending": "UnlimitedEnding",
} as const satisfies Record<
  Exclude<AutomationTriggerKind, "schedule">,
  Exclude<AutomationTrigger["_tag"], "Schedule">
>;

export type EventTriggerKind = keyof typeof eventTriggerTags;
export type EventTrigger = Exclude<AutomationTrigger, { _tag: "Schedule" }>;

export const eventTriggerKinds: readonly EventTriggerKind[] =
  Struct.keys(eventTriggerTags);

export const eventTriggerKindOf = (trigger: EventTrigger): EventTriggerKind =>
  eventTriggerKinds.find((kind) => eventTriggerTags[kind] === trigger._tag) ??
  "reservation-finished";

/** A reservation event trigger, which can narrow to a product, stay, and payment. */
export type ReservationTrigger = Extract<EventTrigger, { product?: unknown }>;

/** What a reservation trigger's event must be, each only when set. */
export type ReservationTriggerQualifiers = Omit<ReservationTrigger, "_tag">;

/** Whether an event trigger is a reservation event, which qualifiers narrow. */
export const isReservationTrigger = (
  trigger: EventTrigger
): trigger is ReservationTrigger =>
  trigger._tag !== "AccountCreated" && !isPassReminderTrigger(trigger);

/** The trigger with one qualifier set, or removed when `value` is undefined. */
export const withReservationQualifier = <
  Key extends keyof ReservationTriggerQualifiers,
>(
  trigger: ReservationTrigger,
  key: Key,
  value: ReservationTriggerQualifiers[Key] | undefined
): ReservationTrigger =>
  value === undefined
    ? withoutReservationQualifier(trigger, key)
    : { ...trigger, [key]: value };

/** The trigger without one qualifier. */
const withoutReservationQualifier = (
  trigger: ReservationTrigger,
  key: keyof ReservationTriggerQualifiers
): ReservationTrigger =>
  Match.value(key).pipe(
    Match.when("product", () => {
      const { product: _, ...rest } = trigger;
      return rest;
    }),
    Match.when("stay", () => {
      const { stay: _, ...rest } = trigger;
      return rest;
    }),
    Match.when("payment", () => {
      const { payment: _, ...rest } = trigger;
      return rest;
    }),
    Match.exhaustive
  );

/**
 * The trigger after switching to `kind`. Reservation triggers keep the
 * product, stay, and payment they had.
 */
export const eventTrigger = (
  kind: EventTriggerKind,
  current: AutomationTrigger | null
): EventTrigger => {
  const tag = eventTriggerTags[kind];
  if (
    tag === "AccountCreated" ||
    tag === "EntryPackExpiring" ||
    tag === "UnlimitedEnding"
  ) {
    return { _tag: tag };
  }
  if (!current || current._tag === "Schedule" || !isReservationTrigger(current))
    return { _tag: tag };
  const { _tag: _, ...qualifiers } = current;
  return { _tag: tag, ...qualifiers };
};

/** A new schedule fires every Monday at 10:00. */
export const defaultScheduleCalendar: CalendarExpression = {
  weekdays: ["monday"],
  hours: [10],
};

/** A new calendar wait waits until 10:00–10:59. */
export const defaultWaitCalendar: CalendarExpression = { hours: [10] };

/**
 * A step id the flow doesn't use yet, such as `wait-2`. Ids are stable, so
 * moving or deleting steps never renames the others.
 */
export const newStepId = (
  kind: InsertableStepKind,
  steps: readonly AutomationStep[]
) => {
  const prefix = kind.toLowerCase();
  const taken = new Set<string>(steps.map(({ id }) => id));
  let number = 1;
  while (taken.has(`${prefix}-${number}`)) number += 1;
  return `${prefix}-${number}`;
};

/** A new step of `kind` with its starting values. */
export const newStep = (
  kind: InsertableStepKind,
  steps: readonly AutomationStep[]
): AutomationStep => {
  const id = newStepId(kind, steps);
  return kind === "Condition"
    ? {
        _tag: "Condition",
        id,
        filter: { _tag: "Group", operator: "and", filters: [] },
      }
    : { _tag: "Wait", id, wait: { _tag: "Duration", count: 1, unit: "day" } };
};

export const insertStepAt = (
  steps: readonly AutomationStep[],
  index: number,
  step: AutomationStep
) => [...steps.slice(0, index), step, ...steps.slice(index)];

export const replaceStepAt = (
  steps: readonly AutomationStep[],
  index: number,
  step: AutomationStep
) => steps.map((current, i) => (i === index ? step : current));

export const removeStepAt = (steps: readonly AutomationStep[], index: number) =>
  steps.filter((_, i) => i !== index);

/** Swaps the step at `index` with its neighbour `by` places away. */
export const moveStep = (
  steps: readonly AutomationStep[],
  index: number,
  by: -1 | 1
) => {
  const target = index + by;
  const moving = steps[index];
  const other = steps[target];
  if (moving === undefined || other === undefined) return steps;
  const swapped = [...steps];
  swapped[index] = other;
  swapped[target] = moving;
  return swapped;
};

/**
 * Whether the step at `index` can move `by` places. The send stays last, so
 * it never moves and no step moves into its place.
 */
export const canMoveStep = (
  steps: readonly AutomationStep[],
  index: number,
  by: -1 | 1
) => {
  const moving = steps[index];
  const target = steps[index + by];
  return (
    moving !== undefined &&
    target !== undefined &&
    moving._tag !== "Send" &&
    target._tag !== "Send"
  );
};

/** The flow a builder starts from when the automation has none yet. */
export const emptyFlowSteps: AutomationFlowFormValues["steps"] = [
  { _tag: "Send", id: "send" },
];
