import type {
  AudienceFilterOf,
  AutomationConditionLeaf,
  AutomationStepType as AutomationStep,
} from "@deskohub/workspace-admin-api";
import { Effect, Match, Option } from "effect";
import {
  type AudienceCondition,
  type AudienceFilterOutcome,
  audienceLeavesOf,
  mapAudienceLeaves,
  occurrenceBounds,
} from "../audience-filter";
import type { AudienceEvaluationContext } from "../backend/audience-evaluation-context";
import type { CampaignPurpose } from "../body/campaign-content";
import { isWithinDatePeriodBounds } from "../date-period";
import type { AutomationStepId } from "./automation-identifiers";
import { oneOffCampaignGapEndsAt } from "./automation-send-policies";
import type {
  AutomationPreviewOutcome,
  AutomationRunSkipReason,
} from "./automation-states";
import {
  evaluateStep,
  type StepState,
  type StepTransition,
} from "./automation-step-evaluation";
import { automationTickAtOrAfter } from "./automation-ticks";

type ConditionStep = Extract<AutomationStep, { readonly _tag: "Condition" }>;
export type SendStep = Extract<AutomationStep, { readonly _tag: "Send" }>;

/** Why a Send step's delivery policies skip a run. */
type SendPolicySkipReason = Extract<
  AutomationRunSkipReason,
  "already-sent-once" | "pass-holder" | "consent-withdrawn"
>;

/** Why the pre-submit check of `skipPassHolders` skips a customer. */
export type SendGuardSkipReason = Extract<
  SendPolicySkipReason,
  "pass-holder" | "consent-withdrawn"
>;

/**
 * What a Send step's delivery policies see for one customer, read once by
 * the caller. Earlier sends and the pre-submit check are observed as they are
 * now, not as they were at a replayed send, like the profile facts the
 * dry run's conditions read.
 */
export type SendPolicyFacts = {
  /**
   * `oncePerCustomer`: the campaign already sent the customer its email, a
   * claim or an earlier run that reached its send (`customersAlreadySentOnce`).
   */
  readonly alreadySentOnce: boolean;
  /**
   * `oneOffCampaignGap`: when the customer's one-off campaign emails went
   * out, ascending. One still in flight is projected as dispatched at its
   * batch's request, or now while no requested batch carries it; live, the
   * run waits for it with short rechecks and then holds the gap from the
   * same instant, so the projection differs only if that email ends failed.
   */
  readonly oneOffCampaignEmails: readonly Temporal.Instant[];
  /** `skipPassHolders`: why the pre-submit check skips the customer now. */
  readonly guardSkip: Option.Option<SendGuardSkipReason>;
};

/** The flow's Send step: a decoded flow always ends with it. */
export const sendStepOf = (steps: readonly AutomationStep[]) =>
  Option.fromUndefinedOr(
    steps.findLast((step): step is SendStep => step._tag === "Send")
  );

/** A Send step's policies see nothing: no claim, no one-off email, no skip. */
export const noSendPolicyFacts: SendPolicyFacts = {
  alreadySentOnce: false,
  oneOffCampaignEmails: [],
  guardSkip: Option.none(),
};

/** Where one simulated run of a flow ends. */
export type SimulatedRunEnd =
  | {
      /** `unavailable`: a Calendar wait with no start within the horizon. */
      readonly outcome: Extract<
        AutomationPreviewOutcome,
        "would-send" | "condition-failed" | "unavailable"
      >;
      readonly stepId: AutomationStepId;
      /** The engine tick of the send, or of the run's end. */
      readonly at: Temporal.Instant;
    }
  | {
      /** A Send step's delivery policy skipped the run. */
      readonly outcome: "skipped";
      readonly skipReason: SendPolicySkipReason;
      readonly stepId: AutomationStepId;
      /** The engine tick the run ended on. */
      readonly at: Temporal.Instant;
    };

/**
 * Walks a flow's steps from `triggerAt` as live execution would, on the
 * engine's ticks and through the same `evaluateStep` the engine uses
 * (design §5.8, §8, D36). The run enters on the first tick at or after the
 * trigger; Condition steps and the send happen on the tick the run reaches
 * them, a Condition asking `evaluateCondition` for its outcome there. A wait
 * is checked on the tick it's entered, then on the first tick at or after
 * its due time, where `evaluateStep` completes it. There is no pause, so no
 * resume overshoot. The Send step applies its delivery policies there (see
 * `sendStepEnd`).
 */
export const simulateRun = <E, R>(input: {
  readonly steps: readonly AutomationStep[];
  readonly triggerAt: Temporal.Instant;
  readonly evaluateCondition: (
    step: ConditionStep,
    at: Temporal.Instant
  ) => Effect.Effect<AudienceFilterOutcome, E, R>;
  /** Read only for a Send step with delivery policies; none by default. */
  readonly sendPolicyFacts?: SendPolicyFacts;
  /** The customer's sends simulated before this run, in this dry run. */
  readonly simulatedSends?: readonly Temporal.Instant[];
}): Effect.Effect<SimulatedRunEnd, E, R> => {
  const enter = (
    steps: readonly AutomationStep[],
    at: Temporal.Instant
  ): Effect.Effect<SimulatedRunEnd, E, R> => {
    const [step, ...rest] = steps;
    // A decoded flow always ends with its send step.
    return step === undefined
      ? Effect.die(new Error("A flow ended without a send step"))
      : next(
          {
            step,
            phase: "ready",
            at,
            stepEnteredAt: at,
            dueAt: Option.none(),
            resumedAt: Option.none(),
            condition: Option.none(),
          },
          rest
        );
  };

  const next = (
    state: StepState,
    rest: readonly AutomationStep[]
  ): Effect.Effect<SimulatedRunEnd, E, R> =>
    Match.value<StepTransition>(evaluateStep(state)).pipe(
      Match.tagsExhaustive({
        EvaluateCondition: () =>
          state.step._tag === "Condition"
            ? input
                .evaluateCondition(state.step, state.at)
                .pipe(
                  Effect.flatMap((outcome) =>
                    next({ ...state, condition: Option.some(outcome) }, rest)
                  )
                )
            : Effect.die(new Error("Only a condition step evaluates one")),
        Advance: ({ at }) => enter(rest, at),
        Wait: ({ dueAt }) =>
          next(
            {
              ...state,
              phase: "waiting",
              at: automationTickAtOrAfter(dueAt),
              dueAt: Option.some(dueAt),
            },
            rest
          ),
        End: (end) =>
          Effect.succeed<SimulatedRunEnd>({
            outcome:
              end.outcome === "condition-failed"
                ? "condition-failed"
                : "unavailable",
            stepId: state.step.id,
            at: state.at,
          }),
        Send: () =>
          state.step._tag === "Send"
            ? Effect.succeed(
                sendStepEnd({
                  step: state.step,
                  at: state.at,
                  facts: input.sendPolicyFacts ?? noSendPolicyFacts,
                  simulatedSends: input.simulatedSends ?? [],
                })
              )
            : Effect.die(new Error("Only a send step sends")),
      })
    );

  return enter(input.steps, automationTickAtOrAfter(input.triggerAt));
};

/**
 * A run reaching its Send step on tick `at`, in the engine's order: the
 * once-ever rule skips a customer the campaign already sent its email,
 * or whose send this dry run already simulated; the one-off campaign gap
 * defers the send; then the pre-submit check skips a pass holder or a
 * customer who withdrew consent, on the tick it would send.
 */
const sendStepEnd = (input: {
  readonly step: SendStep;
  readonly at: Temporal.Instant;
  readonly facts: SendPolicyFacts;
  readonly simulatedSends: readonly Temporal.Instant[];
}): SimulatedRunEnd => {
  const { step, facts } = input;
  if (
    step.oncePerCustomer === true &&
    (facts.alreadySentOnce || input.simulatedSends.length > 0)
  ) {
    return {
      outcome: "skipped",
      skipReason: "already-sent-once",
      stepId: step.id,
      at: input.at,
    };
  }
  const sendAt =
    step.oneOffCampaignGap === undefined
      ? input.at
      : oneOffCampaignGapSendAt({
          at: input.at,
          emails: facts.oneOffCampaignEmails,
          gap: step.oneOffCampaignGap,
        });
  return Option.match(
    step.skipPassHolders === true ? facts.guardSkip : Option.none(),
    {
      onNone: (): SimulatedRunEnd => ({
        outcome: "would-send",
        stepId: step.id,
        at: sendAt,
      }),
      onSome: (skipReason): SimulatedRunEnd => ({
        outcome: "skipped",
        skipReason,
        stepId: step.id,
        at: sendAt,
      }),
    }
  );
};

/**
 * The tick a send on `at` goes out past the one-off campaign gap: while the
 * latest one-off email by then ends its gap later, the run waits for the
 * first tick at or after that end and checks again. A gap ending on the
 * tick itself clears.
 */
const oneOffCampaignGapSendAt = (input: {
  readonly at: Temporal.Instant;
  readonly emails: readonly Temporal.Instant[];
  readonly gap: NonNullable<SendStep["oneOffCampaignGap"]>;
}): Temporal.Instant => {
  const latest = input.emails.findLast(
    (sentAt) => Temporal.Instant.compare(sentAt, input.at) <= 0
  );
  if (latest === undefined) return input.at;
  const endsAt = oneOffCampaignGapEndsAt(latest, input.gap);
  return Temporal.Instant.compare(endsAt, input.at) > 0
    ? oneOffCampaignGapSendAt({
        ...input,
        at: automationTickAtOrAfter(endsAt),
      })
    : input.at;
};

/** A simulated run's row: the send's tick, or why and where it ended. */
export const simulatedRunOutcome = (
  end: SimulatedRunEnd,
  now: Temporal.Instant
): Omit<DryRunOutcome, "triggerAt"> => ({
  outcome: end.outcome,
  stepId: end.stepId,
  sendAt: end.outcome === "would-send" ? end.at : null,
  skipReason: end.outcome === "skipped" ? end.skipReason : null,
  projected: Temporal.Instant.compare(end.at, now) > 0,
});

/** What replaying one event did for its customer. */
export type ReplayedEvent =
  /** Superseded: Dotypos moved the visit later, so a later event stands for it. */
  | { readonly _tag: "Hidden" }
  /** The re-check or the pre-submit check withdrew it. */
  | {
      readonly _tag: "Withdrawn";
      readonly stepId: Option.Option<AutomationStepId>;
      /** When a run it started ended; none when it started no run. */
      readonly at: Option.Option<Temporal.Instant>;
    }
  | { readonly _tag: "NotInAudience" }
  | { readonly _tag: "Entered"; readonly end: SimulatedRunEnd };

/** A dry-run row before it is stored: a computed outcome only (D35). */
export type DryRunOutcome = {
  readonly triggerAt: Temporal.Instant;
  readonly outcome: AutomationPreviewOutcome;
  readonly stepId: AutomationStepId | null;
  readonly sendAt: Temporal.Instant | null;
  /** Why the send step would skip the customer, for `skipped`. */
  readonly skipReason: AutomationRunSkipReason | null;
  /** Evaluated past `now`, from facts as they are now. */
  readonly projected: boolean;
};

/**
 * How far a customer's replay reads reservation statuses approximately
 * (design §8.2). Events before the customer's latest undated status change
 * read them approximately; so does any event whose outcome depends on an
 * approximate one.
 */
export type ReplayApproximation = {
  /** The customer's latest undated status change; none when every read is exact. */
  readonly undatedChangeAt: Option.Option<Temporal.Instant>;
  /** The flow's entry audience or a condition counts this campaign's sends. */
  readonly countsSimulatedSends: boolean;
};

/**
 * Replays one customer's events in time order with per-customer overlays
 * only (design §8.2): an event during the customer's open simulated run is
 * `already-active` (D4), and each simulated send counts toward "this
 * campaign" from its send instant for the later events. `replay` decides
 * one event given the sends simulated before it.
 *
 * A row is approximate when the entry audience or a condition decided it
 * from statuses read before the undated change, or when an approximate row
 * could change it: an approximate row might really have entered, or not,
 * so it could hold off any event up to the latest its run can end, and it
 * might really have sent, or not, before any later decided row: that
 * changes every later row when the flow counts this campaign's sends, and
 * every later row reaching a once-per-customer Send step unless the
 * campaign already sent the customer its email.
 */
export const replayCustomerEvents = <Event, E, R>(input: {
  /** In `occurredAt` order. */
  readonly events: readonly Event[];
  readonly occurredAt: (event: Event) => Temporal.Instant;
  readonly now: Temporal.Instant;
  readonly steps: readonly AutomationStep[];
  readonly approximation: ReplayApproximation;
  /** The customer's facts for the Send step's delivery policies, if it has any. */
  readonly sendPolicyFacts?: SendPolicyFacts;
  readonly replay: (
    event: Event,
    simulatedSends: readonly Temporal.Instant[]
  ) => Effect.Effect<ReplayedEvent, E, R>;
}): Effect.Effect<readonly ReplayedRow<Event>[], E, R> => {
  const projected = (at: Temporal.Instant) =>
    Temporal.Instant.compare(at, input.now) > 0;
  // A row reaching a once-per-customer Send step depends on whether an
  // earlier row really sent.
  const oncePerCustomerSend = Option.filter(
    sendStepOf(input.steps),
    (step) => step.oncePerCustomer === true
  );
  // A customer the campaign already sent once is skipped whatever the
  // simulated sends did.
  const decidedByOncePerCustomer = (outcome: DecidedEvent["outcome"]) =>
    input.sendPolicyFacts?.alreadySentOnce !== true &&
    Option.exists(oncePerCustomerSend, (step) => outcome.stepId === step.id);
  const beforeUndatedChange = (triggerAt: Temporal.Instant) =>
    Option.exists(
      input.approximation.undatedChangeAt,
      (changedAt) => Temporal.Instant.compare(triggerAt, changedAt) < 0
    );

  const next = (
    events: readonly Event[],
    replayed: CustomerReplay<Event>
  ): Effect.Effect<readonly ReplayedRow<Event>[], E, R> => {
    const [event, ...rest] = events;
    if (event === undefined) return Effect.succeed(replayed.rows);
    const triggerAt = input.occurredAt(event);
    // The engine takes an event in before that tick's runs move, so a run
    // ending on the event's tick still holds it off.
    const intakeAt = automationTickAtOrAfter(triggerAt);
    const heldOffBy = (until: Option.Option<Temporal.Instant>) =>
      Option.exists(until, (at) => Temporal.Instant.compare(intakeAt, at) <= 0);
    const withRow = (decided: DecidedEvent) => {
      const approximate =
        heldOffBy(replayed.approximateUntil) ||
        (decided.evaluated &&
          (beforeUndatedChange(triggerAt) ||
            (replayed.sendsApproximate &&
              (input.approximation.countsSimulatedSends ||
                decidedByOncePerCustomer(decided.outcome)))));
      const state: CustomerReplay<Event> = {
        ...replayed,
        ...decided.state,
        rows: [
          ...replayed.rows,
          {
            event,
            outcome: { triggerAt, ...decided.outcome },
            reservationStatusesApproximate: approximate,
          },
        ],
      };
      return { state, approximate };
    };
    // An approximate row could hold off events until its latest end.
    const widenApproximation = ({
      state,
      approximate,
    }: ReturnType<typeof withRow>) =>
      approximate
        ? latestRunEnd({
            steps: input.steps,
            triggerAt,
            sendPolicyFacts: input.sendPolicyFacts,
          }).pipe(
            Effect.map(
              (latestEnd): CustomerReplay<Event> => ({
                ...state,
                approximateUntil: Option.some(
                  Option.match(state.approximateUntil, {
                    onNone: () => latestEnd,
                    onSome: (until) =>
                      Temporal.Instant.compare(until, latestEnd) > 0
                        ? until
                        : latestEnd,
                  })
                ),
                sendsApproximate: true,
              })
            )
          )
        : Effect.succeed(state);
    const decided: Effect.Effect<Option.Option<DecidedEvent>, E, R> = heldOffBy(
      replayed.openUntil
    )
      ? Effect.succeed(
          Option.some<DecidedEvent>({
            outcome: {
              outcome: "already-active",
              stepId: null,
              sendAt: null,
              skipReason: null,
              projected: false,
            },
            evaluated: false,
            state: {},
          })
        )
      : input.replay(event, replayed.sends).pipe(
          Effect.map((outcome) =>
            Match.value(outcome).pipe(
              Match.tagsExhaustive({
                Hidden: () => Option.none<DecidedEvent>(),
                NotInAudience: () =>
                  Option.some<DecidedEvent>({
                    outcome: {
                      outcome: "not-in-audience",
                      stepId: null,
                      sendAt: null,
                      skipReason: null,
                      projected: false,
                    },
                    evaluated: true,
                    state: {},
                  }),
                Withdrawn: ({ stepId, at }) =>
                  Option.some<DecidedEvent>({
                    outcome: {
                      outcome: "withdrawn",
                      stepId: Option.getOrNull(stepId),
                      sendAt: null,
                      skipReason: null,
                      projected: Option.exists(at, projected),
                    },
                    // A run it started passed the entry audience first.
                    evaluated: Option.isSome(stepId),
                    state: {
                      openUntil: Option.orElse(at, () => replayed.openUntil),
                    },
                  }),
                Entered: ({ end }) =>
                  Option.some<DecidedEvent>({
                    outcome: simulatedRunOutcome(end, input.now),
                    evaluated: true,
                    state: {
                      sends:
                        end.outcome === "would-send"
                          ? [...replayed.sends, end.at]
                          : replayed.sends,
                      // A deferred send holds the customer off until it goes out.
                      openUntil: Option.some(end.at),
                    },
                  }),
              })
            )
          )
        );
    return decided.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(replayed),
          onSome: (row) => widenApproximation(withRow(row)),
        })
      ),
      Effect.flatMap((state) => next(rest, state))
    );
  };

  return next(input.events, {
    rows: [],
    sends: [],
    openUntil: Option.none(),
    approximateUntil: Option.none(),
    sendsApproximate: false,
  });
};

/**
 * The latest tick a run from `triggerAt` can end on: one where every
 * condition matches and the send goes out past the one-off campaign gap. A
 * flow is linear and a run reaches each step on the same tick whatever came
 * before, so a run that ends sooner, a condition failing, a calendar never
 * occurring or the once-ever claim skipping it, can only end earlier.
 */
const latestRunEnd = (input: {
  readonly steps: readonly AutomationStep[];
  readonly triggerAt: Temporal.Instant;
  readonly sendPolicyFacts: SendPolicyFacts | undefined;
}) =>
  simulateRun({
    steps: input.steps,
    triggerAt: input.triggerAt,
    evaluateCondition: () => Effect.succeed<AudienceFilterOutcome>("match"),
    sendPolicyFacts: {
      ...(input.sendPolicyFacts ?? noSendPolicyFacts),
      alreadySentOnce: false,
    },
  }).pipe(Effect.map(({ at }) => at));

/** One event's row before it joins the replay, with the state it leaves. */
type DecidedEvent = {
  readonly outcome: Omit<DryRunOutcome, "triggerAt">;
  /** The entry audience, and any conditions, decided it. */
  readonly evaluated: boolean;
  readonly state: Partial<Pick<CustomerReplay<unknown>, "sends" | "openUntil">>;
};

/** One replayed event with its computed outcome. */
export type ReplayedRow<Event> = {
  readonly event: Event;
  readonly outcome: DryRunOutcome;
  /** It read reservation statuses approximately, or depends on a row that did. */
  readonly reservationStatusesApproximate: boolean;
};

/** One customer's replay so far: rows, simulated sends and the open run. */
type CustomerReplay<Event> = {
  readonly rows: readonly ReplayedRow<Event>[];
  readonly sends: readonly Temporal.Instant[];
  /** The tick the customer's latest simulated run ends on (D4). */
  readonly openUntil: Option.Option<Temporal.Instant>;
  /**
   * The latest tick a run of an approximate row could end on. Until then,
   * an event might have been held off, or let in, otherwise.
   */
  readonly approximateUntil: Option.Option<Temporal.Instant>;
  /** An approximate row might have sent, or not, unlike its replay. */
  readonly sendsApproximate: boolean;
};

type CampaignEmailCount = Extract<
  AudienceCondition,
  { readonly attribute: "campaignEmailCount" }
>;

const isCampaignEmailCount = (
  leaf: AutomationConditionLeaf
): leaf is CampaignEmailCount =>
  leaf._tag === "Condition" && leaf.attribute === "campaignEmailCount";

/**
 * A filter as the replay evaluates it in its replayed `context` (design
 * §8.2), which counts only campaign emails dispatched by the evaluation
 * time. Each send simulated by then counts toward the conditions that would
 * count this campaign's email: shifting the compared value by the simulated
 * sends in the period gives the same outcome as adding them to the stored
 * count, for every count operator.
 */
export const replayedFilter = <Leaf extends AutomationConditionLeaf>(
  filter: AudienceFilterOf<Leaf>,
  input: {
    readonly context: AudienceEvaluationContext;
    readonly purpose: CampaignPurpose;
    readonly simulatedSends: readonly Temporal.Instant[];
  }
): AudienceFilterOf<Leaf> =>
  mapAudienceLeaves(filter, (leaf) =>
    isCampaignEmailCount(leaf) ? replayedEmailCount(leaf, input) : leaf
  );

const replayedEmailCount = <Condition extends CampaignEmailCount>(
  condition: Condition,
  input: {
    readonly context: AudienceEvaluationContext;
    readonly purpose: CampaignPurpose;
    readonly simulatedSends: readonly Temporal.Instant[];
  }
): Condition => {
  const bounds = occurrenceBounds(condition.params.period, input.context);
  const simulated = countsSimulatedSends(condition.params, input)
    ? input.simulatedSends.filter((at) => isWithinDatePeriodBounds(bounds, at))
        .length
    : 0;
  return { ...condition, value: condition.value - simulated };
};

/**
 * Whether a filter counts the evaluating campaign's emails, so the sends a
 * replay simulates shift it.
 */
export const countsSimulatedSendsIn = <Leaf extends AutomationConditionLeaf>(
  filter: AudienceFilterOf<Leaf>,
  input: {
    readonly context: AudienceEvaluationContext;
    readonly purpose: CampaignPurpose;
  }
) =>
  audienceLeavesOf(filter).some(
    (leaf) =>
      isCampaignEmailCount(leaf) && countsSimulatedSends(leaf.params, input)
  );

/**
 * Whether the condition counts the evaluating campaign's emails: any
 * campaign of its purpose, or this campaign itself. A simulated send is
 * the evaluating campaign's email.
 */
const countsSimulatedSends = (
  params: CampaignEmailCount["params"],
  {
    context,
    purpose,
  }: {
    readonly context: AudienceEvaluationContext;
    readonly purpose: CampaignPurpose;
  }
) =>
  params.campaign === undefined
    ? params.purpose === "any" || params.purpose === purpose
    : Match.value(params.campaign).pipe(
        Match.tagsExhaustive({
          This: () => true,
          Specific: ({ campaignId }) =>
            Option.contains(context.campaignId, campaignId),
        })
      );
