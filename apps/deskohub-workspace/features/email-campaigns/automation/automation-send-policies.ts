import type { AutomationOneOffCampaignGapType as AutomationOneOffCampaignGap } from "@deskohub/workspace-admin-api";
import { Data, Option } from "effect";
import { workspaceSiteConstants } from "@/shared/utils";
import { addCalendarDuration } from "@/shared/utils/temporal";
import type { OneOffCampaignEmails } from "../backend/campaign-candidate.repository";
import type {
  AutomationRunSkipReason,
  AutomationSendDeferralCause,
} from "./automation-states";

/**
 * When a Send's one-off campaign gap after the customer's latest one-off
 * campaign email ends: that many Prague calendar days later. The send may
 * go out at this instant.
 */
export const oneOffCampaignGapEndsAt = (
  latestOneOffEmailAt: Temporal.Instant,
  gap: AutomationOneOffCampaignGap
) =>
  addCalendarDuration({
    instant: latestOneOffEmailAt,
    duration: { days: gap.days },
    timeZone: workspaceSiteConstants.location.timeZone,
  });

/**
 * When a send the one-off campaign gap holds at `at` is checked again: the
 * gap's end after the latest one-off email the customer received, while
 * it's still ahead, or `inFlightRecheckAt` while a one-off email is in
 * flight to them, whichever is later. None when the gap doesn't hold it;
 * a gap ending exactly at `at` has ended.
 */
export const oneOffCampaignGapHold = (input: {
  readonly emails: OneOffCampaignEmails | undefined;
  readonly gap: AutomationOneOffCampaignGap;
  readonly at: Temporal.Instant;
  readonly inFlightRecheckAt: Temporal.Instant;
}): Option.Option<Temporal.Instant> => {
  const { emails } = input;
  if (emails === undefined) return Option.none();
  const holds = [
    ...(emails.latestReceivedAt === null
      ? []
      : [oneOffCampaignGapEndsAt(emails.latestReceivedAt, input.gap)]
    ).filter((end) => Temporal.Instant.compare(end, input.at) > 0),
    ...(emails.inFlight ? [input.inFlightRecheckAt] : []),
  ];
  return holds.length === 0
    ? Option.none()
    : Option.some(holds.reduce(laterInstant));
};

const laterInstant = (a: Temporal.Instant, b: Temporal.Instant) =>
  Temporal.Instant.compare(a, b) >= 0 ? a : b;

/** What the deliver unit's commit does with one run (§5.9 step 2). */
export type DeliverVerdict = Data.TaggedEnum<{
  Send: Record<never, never>;
  Withdraw: Record<never, never>;
  Skip: { readonly reason: AutomationRunSkipReason };
  Defer: {
    readonly recheckAt: Temporal.Instant;
    readonly cause: AutomationSendDeferralCause;
  };
}>;
export const DeliverVerdict = Data.taggedEnum<DeliverVerdict>();

/**
 * One run's verdict from its trigger, its once-per-customer send's earlier
 * email to the customer and the one-off campaign gap: a withdrawn trigger
 * withdraws it; otherwise a customer the campaign already sent its email
 * skips it; otherwise a moved
 * trigger or the gap defers it to the later of their rechecks.
 */
export const deliverVerdictOf = (input: {
  readonly trigger: "send" | "withdraw" | "defer";
  readonly alreadySentOnce: boolean;
  readonly gapHold: Option.Option<Temporal.Instant>;
  readonly triggerRecheckAt: Temporal.Instant;
}): DeliverVerdict => {
  if (input.trigger === "withdraw") return DeliverVerdict.Withdraw();
  if (input.alreadySentOnce)
    return DeliverVerdict.Skip({ reason: "already-sent-once" });
  const deferrals = [
    ...(input.trigger === "defer"
      ? [
          {
            recheckAt: input.triggerRecheckAt,
            cause: "trigger-not-reached" as const,
          },
        ]
      : []),
    ...Option.toArray(
      Option.map(input.gapHold, (recheckAt) => ({
        recheckAt,
        cause: "one-off-campaign-gap" as const,
      }))
    ),
  ];
  const [first, ...rest] = deferrals;
  if (first === undefined) return DeliverVerdict.Send();
  // The later recheck wins; the gap names a tie.
  return DeliverVerdict.Defer(
    rest.reduce(
      (later, deferral) =>
        Temporal.Instant.compare(deferral.recheckAt, later.recheckAt) >= 0
          ? deferral
          : later,
      first
    )
  );
};
