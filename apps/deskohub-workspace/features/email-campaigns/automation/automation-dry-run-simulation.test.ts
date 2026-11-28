import { describe, expect, test } from "bun:test";
import {
  type AutomationStepType as AutomationStep,
  AutomationStepId,
  type AutomationWaitType as AutomationWait,
} from "@deskohub/workspace-admin-api";
import { Effect, Option } from "effect";
import type { AudienceFilterOutcome } from "../audience-filter";
import { campaignAudienceIdSchema } from "../campaign-identifiers";
import {
  noSendPolicyFacts,
  type ReplayedEvent,
  replayCustomerEvents,
  type SendPolicyFacts,
  simulateRun,
} from "./automation-dry-run-simulation";

const at = (instant: string) => Temporal.Instant.from(instant);

const send: AutomationStep = {
  _tag: "Send",
  id: AutomationStepId.make("send"),
};

const condition = (id: string): AutomationStep => ({
  _tag: "Condition",
  id: AutomationStepId.make(id),
  filter: {
    _tag: "InAudience",
    audienceId: campaignAudienceIdSchema.make("audience"),
    operator: "in",
  },
});

const wait = (wait: AutomationWait): AutomationStep => ({
  _tag: "Wait",
  id: AutomationStepId.make("wait"),
  wait,
});

/** Simulates `steps` from `triggerAt`, every condition matching, and records when each was asked. */
const simulate = (steps: readonly AutomationStep[], triggerAt: string) => {
  const asked: string[] = [];
  const end = Effect.runSync(
    simulateRun({
      steps: [...steps, send],
      triggerAt: at(triggerAt),
      evaluateCondition: (step, conditionAt) => {
        asked.push(`${step.id}@${conditionAt.toString()}`);
        return Effect.succeed<AudienceFilterOutcome>("match");
      },
    })
  );
  return { end, asked };
};

describe("simulateRun on engine ticks", () => {
  test("an event at 10:07 with a two-hour delay sends at 12:15, not 12:07", () => {
    const { end } = simulate(
      [wait({ _tag: "Duration", count: 2, unit: "hour" })],
      "2026-10-21T10:07:00Z"
    );
    expect(end).toMatchObject({ outcome: "would-send" });
    expect(end.at).toEqual(at("2026-10-21T12:15:00Z"));
  });

  test("conditions and the send happen on the trigger's tick", () => {
    const { end, asked } = simulate(
      [condition("first"), condition("second")],
      "2026-10-21T10:07:00Z"
    );
    expect(asked).toEqual([
      "first@2026-10-21T10:15:00Z",
      "second@2026-10-21T10:15:00Z",
    ]);
    expect(end.at).toEqual(at("2026-10-21T10:15:00Z"));
  });

  test("a calendar wait for a non-tick minute completes on the tick after it", () => {
    const { end } = simulate(
      [wait({ _tag: "Calendar", expression: { minutes: [7] } })],
      "2026-10-21T10:00:00Z"
    );
    expect(end.at).toEqual(at("2026-10-21T10:15:00Z"));
  });

  test("a calendar wait that holds on the tick it's entered completes then", () => {
    const { end } = simulate(
      [wait({ _tag: "Calendar", expression: { hours: [11] } })],
      "2026-10-21T08:52:00Z"
    );
    // 11:00 in Prague.
    expect(end.at).toEqual(at("2026-10-21T09:00:00Z"));
  });

  test("a schedule fire on a tick enters on that tick", () => {
    const { end } = simulate(
      [wait({ _tag: "Duration", count: 1, unit: "day" })],
      "2026-10-21T08:30:00Z"
    );
    expect(end.at).toEqual(at("2026-10-22T08:30:00Z"));
  });

  test("a condition after a wait is asked on the tick the wait completes", () => {
    const { asked } = simulate(
      [
        wait({ _tag: "Duration", count: 50, unit: "minute" }),
        condition("after"),
      ],
      "2026-10-21T10:00:00Z"
    );
    expect(asked).toEqual(["after@2026-10-21T11:00:00Z"]);
  });

  test("a one-minute wait entered on a tick sends on the next tick", () => {
    const { end } = simulate(
      [wait({ _tag: "Duration", count: 1, unit: "minute" })],
      "2026-10-21T12:00:00Z"
    );
    expect(end).toMatchObject({ outcome: "would-send" });
    expect(end.at).toEqual(at("2026-10-21T12:15:00Z"));
  });

  test("a calendar wait for a minute after the tick sends on the next tick", () => {
    const { end } = simulate(
      [wait({ _tag: "Calendar", expression: { minutes: [1] } })],
      "2026-10-21T12:00:00Z"
    );
    expect(end).toMatchObject({ outcome: "would-send" });
    expect(end.at).toEqual(at("2026-10-21T12:15:00Z"));
  });

  test("an event just after a tick waits two hours from the next tick", () => {
    const { end } = simulate(
      [wait({ _tag: "Duration", count: 2, unit: "hour" })],
      "2026-10-21T12:00:20Z"
    );
    expect(end.at).toEqual(at("2026-10-21T14:15:00Z"));
  });

  test("a two-hour delay entered on a tick sends two hours later", () => {
    const { end } = simulate(
      [wait({ _tag: "Duration", count: 2, unit: "hour" })],
      "2026-10-21T12:00:00Z"
    );
    expect(end.at).toEqual(at("2026-10-21T14:00:00Z"));
  });

  test("a day's wait across the autumn DST change keeps Prague's wall time", () => {
    // Taken in on the 00:00 CEST tick, sent at 00:00 CET, 25 hours later.
    const { end } = simulate(
      [wait({ _tag: "Duration", count: 1, unit: "day" })],
      "2026-10-24T21:52:00Z"
    );
    expect(end.at).toEqual(at("2026-10-25T23:00:00Z"));
  });

  test("a 7-minute wait entered at 10:15 completes at 10:30", () => {
    const { end } = simulate(
      [wait({ _tag: "Duration", count: 7, unit: "minute" })],
      "2026-10-21T10:15:00Z"
    );
    expect(end.at).toEqual(at("2026-10-21T10:30:00Z"));
  });
});

describe("replayCustomerEvents on engine ticks", () => {
  /** Replays events where every run sends on its entry tick. */
  const replay = (events: readonly string[]) =>
    Effect.runSync(
      replayCustomerEvents({
        events: events.map(at),
        occurredAt: (event) => event,
        now: at("2026-10-22T00:00:00Z"),
        steps: [send],
        approximation: {
          undatedChangeAt: Option.none(),
          countsSimulatedSends: false,
        },
        replay: (event) =>
          Effect.map(
            simulateRun({
              steps: [send],
              triggerAt: event,
              evaluateCondition: () => Effect.succeed("match" as const),
            }),
            (end): ReplayedEvent => ({ _tag: "Entered", end })
          ),
      })
    ).map(({ outcome }) => [outcome.outcome, outcome.sendAt?.toString()]);

  test("an event taken in on the tick an earlier run ends is already active", () => {
    expect(replay(["2026-10-21T10:01:00Z", "2026-10-21T10:10:00Z"])).toEqual([
      ["would-send", "2026-10-21T10:15:00Z"],
      ["already-active", undefined],
    ]);
  });

  test("an event taken in on a later tick starts its own run", () => {
    expect(replay(["2026-10-21T10:01:00Z", "2026-10-21T10:16:00Z"])).toEqual([
      ["would-send", "2026-10-21T10:15:00Z"],
      ["would-send", "2026-10-21T10:30:00Z"],
    ]);
  });
});

describe("simulateRun at a Send step with delivery policies", () => {
  const sendWith = (
    policies: Omit<Extract<AutomationStep, { _tag: "Send" }>, "_tag" | "id">
  ): AutomationStep => ({ ...send, ...policies });
  const gap = { oneOffCampaignGap: { days: 14 } } as const;

  /** Simulates a lone Send from `triggerAt` with the customer's policy facts. */
  const simulateSend = (input: {
    readonly step: AutomationStep;
    readonly triggerAt: string;
    readonly facts?: Partial<SendPolicyFacts>;
    readonly simulatedSends?: readonly string[];
  }) => {
    const end = Effect.runSync(
      simulateRun({
        steps: [input.step],
        triggerAt: at(input.triggerAt),
        evaluateCondition: () => Effect.succeed("match" as const),
        sendPolicyFacts: { ...noSendPolicyFacts, ...input.facts },
        simulatedSends: input.simulatedSends?.map(at),
      })
    );
    return {
      outcome: end.outcome,
      at: end.at.toString(),
      skipReason: end.outcome === "skipped" ? end.skipReason : null,
    };
  };

  test("a Send without policies sends on its tick whatever the facts", () => {
    expect(
      simulateSend({
        step: send,
        triggerAt: "2026-10-21T10:01:00Z",
        facts: {
          alreadySentOnce: true,
          oneOffCampaignEmails: [at("2026-10-20T10:00:00Z")],
          guardSkip: Option.some("pass-holder"),
        },
        simulatedSends: ["2026-10-01T10:00:00Z"],
      })
    ).toEqual({
      outcome: "would-send",
      at: "2026-10-21T10:15:00Z",
      skipReason: null,
    });
  });

  test("a claim another run holds skips the send as already sent once", () => {
    expect(
      simulateSend({
        step: sendWith({ oncePerCustomer: true }),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: { alreadySentOnce: true },
      })
    ).toEqual({
      outcome: "skipped",
      at: "2026-10-21T10:15:00Z",
      skipReason: "already-sent-once",
    });
  });

  test("a send simulated earlier in the dry run claims the customer", () => {
    expect(
      simulateSend({
        step: sendWith({ oncePerCustomer: true }),
        triggerAt: "2026-10-21T10:01:00Z",
        simulatedSends: ["2026-10-01T10:00:00Z"],
      })
    ).toMatchObject({ outcome: "skipped", skipReason: "already-sent-once" });
  });

  test("the claim skips on the send's tick before the gap would defer it", () => {
    expect(
      simulateSend({
        step: sendWith({ oncePerCustomer: true, ...gap }),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: {
          alreadySentOnce: true,
          oneOffCampaignEmails: [at("2026-10-20T10:00:00Z")],
        },
      })
    ).toEqual({
      outcome: "skipped",
      at: "2026-10-21T10:15:00Z",
      skipReason: "already-sent-once",
    });
  });

  test("a one-off email within the gap defers the send to the gap's end", () => {
    expect(
      simulateSend({
        step: sendWith(gap),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: { oneOffCampaignEmails: [at("2026-10-10T08:00:00Z")] },
      })
    ).toEqual({
      outcome: "would-send",
      at: "2026-10-24T08:00:00Z",
      skipReason: null,
    });
  });

  test("a gap ending on the send's tick clears it", () => {
    expect(
      simulateSend({
        step: sendWith(gap),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: { oneOffCampaignEmails: [at("2026-10-07T10:15:00Z")] },
      }).at
    ).toBe("2026-10-21T10:15:00Z");
  });

  test("a gap ending a minute after the send's tick defers it to the next tick", () => {
    expect(
      simulateSend({
        step: sendWith(gap),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: { oneOffCampaignEmails: [at("2026-10-07T10:16:00Z")] },
      }).at
    ).toBe("2026-10-21T10:30:00Z");
  });

  test("a one-off email after the send doesn't defer it", () => {
    expect(
      simulateSend({
        step: sendWith(gap),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: { oneOffCampaignEmails: [at("2026-10-22T12:00:00Z")] },
      }).at
    ).toBe("2026-10-21T10:15:00Z");
  });

  test("a one-off email during the deferral defers the send again, in Prague days", () => {
    expect(
      simulateSend({
        step: sendWith(gap),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: {
          oneOffCampaignEmails: [
            at("2026-10-10T08:00:00Z"),
            at("2026-10-22T12:00:00Z"),
          ],
        },
      }).at
      // 14:00 in Prague on 22 October, two weeks later after the DST change.
    ).toBe("2026-11-05T13:00:00Z");
  });

  test("a pass holder is skipped on the tick the deferred send would go out", () => {
    expect(
      simulateSend({
        step: sendWith({ skipPassHolders: true, ...gap }),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: {
          oneOffCampaignEmails: [at("2026-10-10T08:00:00Z")],
          guardSkip: Option.some("pass-holder"),
        },
      })
    ).toEqual({
      outcome: "skipped",
      at: "2026-10-24T08:00:00Z",
      skipReason: "pass-holder",
    });
  });

  test("a customer who withdrew consent is skipped", () => {
    expect(
      simulateSend({
        step: sendWith({ skipPassHolders: true }),
        triggerAt: "2026-10-21T10:01:00Z",
        facts: { guardSkip: Option.some("consent-withdrawn") },
      })
    ).toEqual({
      outcome: "skipped",
      at: "2026-10-21T10:15:00Z",
      skipReason: "consent-withdrawn",
    });
  });

  describe("in a customer's replay", () => {
    const replayRows = (
      step: AutomationStep,
      facts: Partial<SendPolicyFacts>,
      events: readonly string[],
      undatedChangeAt: Option.Option<Temporal.Instant> = Option.none()
    ) => {
      const sendPolicyFacts = { ...noSendPolicyFacts, ...facts };
      return Effect.runSync(
        replayCustomerEvents({
          events: events.map(at),
          occurredAt: (event) => event,
          now: at("2026-10-22T00:00:00Z"),
          steps: [step],
          approximation: { undatedChangeAt, countsSimulatedSends: false },
          sendPolicyFacts,
          replay: (event, simulatedSends) =>
            Effect.map(
              simulateRun({
                steps: [step],
                triggerAt: event,
                evaluateCondition: () => Effect.succeed("match" as const),
                sendPolicyFacts,
                simulatedSends,
              }),
              (end): ReplayedEvent => ({ _tag: "Entered", end })
            ),
        })
      );
    };
    const replayWith = (
      step: AutomationStep,
      facts: Partial<SendPolicyFacts>,
      events: readonly string[]
    ) =>
      replayRows(step, facts, events).map(({ outcome }) => [
        outcome.outcome,
        outcome.sendAt?.toString() ?? null,
        outcome.skipReason,
        outcome.projected,
      ]);

    test("a deferred send holds later events off until it goes out", () => {
      expect(
        replayWith(
          sendWith(gap),
          { oneOffCampaignEmails: [at("2026-10-10T08:00:00Z")] },
          [
            "2026-10-21T10:01:00Z",
            "2026-10-24T08:00:00Z",
            "2026-10-24T08:01:00Z",
          ]
        )
      ).toEqual([
        ["would-send", "2026-10-24T08:00:00Z", null, true],
        ["already-active", null, null, false],
        ["would-send", "2026-10-24T08:15:00Z", null, true],
      ]);
    });

    test("a send simulated for an earlier event skips the later ones once per customer", () => {
      expect(
        replayWith(sendWith({ oncePerCustomer: true }), {}, [
          "2026-10-10T10:01:00Z",
          "2026-10-12T10:01:00Z",
        ])
      ).toEqual([
        ["would-send", "2026-10-10T10:15:00Z", null, false],
        ["skipped", null, "already-sent-once", false],
      ]);
    });

    test("a row skipped once per customer after an approximate send is approximate too", () => {
      const events = ["2026-10-10T10:01:00Z", "2026-10-12T10:01:00Z"];
      // Statuses read for the first event predate an undated change.
      const undatedChangeAt = Option.some(at("2026-10-11T00:00:00Z"));
      const rowsOf = (step: AutomationStep) =>
        replayRows(step, {}, events, undatedChangeAt).map(
          ({ outcome, reservationStatusesApproximate }) => [
            outcome.outcome,
            outcome.skipReason,
            reservationStatusesApproximate,
          ]
        );

      expect(rowsOf(sendWith({ oncePerCustomer: true }))).toEqual([
        ["would-send", null, true],
        ["skipped", "already-sent-once", true],
      ]);
      // Without the policy the later row doesn't depend on the earlier send.
      expect(rowsOf(send)).toEqual([
        ["would-send", null, true],
        ["would-send", null, false],
      ]);
    });

    test("a customer already sent once is skipped exactly after an approximate row", () => {
      const rows = replayRows(
        sendWith({ oncePerCustomer: true }),
        { alreadySentOnce: true },
        ["2026-10-10T10:01:00Z", "2026-10-12T10:01:00Z"],
        Option.some(at("2026-10-11T00:00:00Z"))
      ).map(({ outcome, reservationStatusesApproximate }) => [
        outcome.outcome,
        outcome.skipReason,
        reservationStatusesApproximate,
      ]);

      expect(rows).toEqual([
        ["skipped", "already-sent-once", true],
        ["skipped", "already-sent-once", false],
      ]);
    });

    test("a skipped send claims nothing for the later events", () => {
      expect(
        replayWith(
          sendWith({ oncePerCustomer: true, skipPassHolders: true }),
          { guardSkip: Option.some("pass-holder") },
          ["2026-10-10T10:01:00Z", "2026-10-12T10:01:00Z"]
        ).map(([outcome, , skipReason]) => [outcome, skipReason])
      ).toEqual([
        ["skipped", "pass-holder"],
        ["skipped", "pass-holder"],
      ]);
    });
  });
});
