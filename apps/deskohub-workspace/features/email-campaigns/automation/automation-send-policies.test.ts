import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import {
  DeliverVerdict,
  deliverVerdictOf,
  oneOffCampaignGapHold,
} from "./automation-send-policies";

const instant = Temporal.Instant.from;
const gap = { days: 14 };
/** Tuesday 20 October 2026, 10:00 in Prague (summer time). */
const at = instant("2026-10-20T08:00:00Z");
const inFlightRecheckAt = instant("2026-10-20T08:15:00Z");

const hold = (emails: {
  readonly latestReceivedAt: Temporal.Instant | null;
  readonly inFlight: boolean;
}) =>
  Option.map(
    oneOffCampaignGapHold({ emails, gap, at, inFlightRecheckAt }),
    String
  );

describe("oneOffCampaignGapHold", () => {
  test("holds a send until 14 Prague calendar days after the latest one-off email, across a clock change", () => {
    // 15 October, 10:00 CEST plus 14 days is 29 October, 10:00 CET.
    expect(
      hold({
        latestReceivedAt: instant("2026-10-15T08:00:00Z"),
        inFlight: false,
      })
    ).toEqual(Option.some("2026-10-29T09:00:00Z"));
  });

  test("lets the send go once the gap ends at or before the send instant", () => {
    expect(
      hold({
        latestReceivedAt: instant("2026-10-06T08:00:00Z"),
        inFlight: false,
      })
    ).toEqual(Option.none());
    expect(
      hold({
        latestReceivedAt: instant("2026-10-06T07:59:59Z"),
        inFlight: false,
      })
    ).toEqual(Option.none());
    expect(
      hold({
        latestReceivedAt: instant("2026-10-06T08:00:01Z"),
        inFlight: false,
      })
    ).toEqual(Option.some("2026-10-20T08:00:01Z"));
  });

  test("rechecks soon while a one-off email is in flight, unless a received one holds the send longer", () => {
    expect(hold({ latestReceivedAt: null, inFlight: true })).toEqual(
      Option.some("2026-10-20T08:15:00Z")
    );
    expect(
      hold({
        latestReceivedAt: instant("2026-10-01T08:00:00Z"),
        inFlight: true,
      })
    ).toEqual(Option.some("2026-10-20T08:15:00Z"));
    expect(
      hold({
        latestReceivedAt: instant("2026-10-15T08:00:00Z"),
        inFlight: true,
      })
    ).toEqual(Option.some("2026-10-29T09:00:00Z"));
  });

  test("doesn't hold a customer without one-off emails", () => {
    expect(
      oneOffCampaignGapHold({ emails: undefined, gap, at, inFlightRecheckAt })
    ).toEqual(Option.none());
  });
});

describe("deliverVerdictOf", () => {
  const triggerRecheckAt = instant("2026-10-20T08:15:00Z");
  const gapEndsAt = instant("2026-11-03T08:00:00Z");
  const verdict = (input: {
    readonly trigger: "send" | "withdraw" | "defer";
    readonly alreadySentOnce?: boolean;
    readonly gapHold?: Temporal.Instant;
  }) => {
    const judged = deliverVerdictOf({
      trigger: input.trigger,
      alreadySentOnce: input.alreadySentOnce ?? false,
      gapHold: Option.fromNullishOr(input.gapHold),
      triggerRecheckAt,
    });
    // Temporal instants all look equal to toEqual, so compare their text.
    return judged._tag === "Defer"
      ? { ...judged, recheckAt: judged.recheckAt.toString() }
      : judged;
  };

  const deferral = (cause: "trigger-not-reached" | "one-off-campaign-gap") => ({
    ...DeliverVerdict.Defer({ recheckAt: triggerRecheckAt, cause }),
    recheckAt: triggerRecheckAt.toString(),
  });

  test("a withdrawn trigger withdraws the run before its claim or gap", () => {
    expect(
      verdict({
        trigger: "withdraw",
        alreadySentOnce: true,
        gapHold: gapEndsAt,
      })
    ).toEqual(DeliverVerdict.Withdraw());
  });

  test("a customer already sent once skips the run before any deferral", () => {
    expect(
      verdict({ trigger: "defer", alreadySentOnce: true, gapHold: gapEndsAt })
    ).toEqual(DeliverVerdict.Skip({ reason: "already-sent-once" }));
  });

  test("a moved trigger and the gap defer the run to the later recheck", () => {
    expect(verdict({ trigger: "defer", gapHold: gapEndsAt })).toEqual({
      ...deferral("one-off-campaign-gap"),
      recheckAt: gapEndsAt.toString(),
    });
    const earlierGap = instant("2026-10-20T08:05:00Z");
    expect(verdict({ trigger: "defer", gapHold: earlierGap })).toEqual(
      deferral("trigger-not-reached")
    );
  });

  test("the gap names a tie with the moved trigger", () => {
    expect(verdict({ trigger: "defer", gapHold: triggerRecheckAt })).toEqual(
      deferral("one-off-campaign-gap")
    );
  });

  test("a current trigger with no claim or gap sends", () => {
    expect(verdict({ trigger: "send" })).toEqual(DeliverVerdict.Send());
  });
});
