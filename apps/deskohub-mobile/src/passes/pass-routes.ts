import { Option } from "effect";
import type { CoworkDraft } from "../booking/selection/cowork-selection";
import { coworkPassTier } from "./entry-pack-booking";

export const entryPackPurchaseHref = "/passes/entry-pack" as const;
export const unlimitedPurchaseHref = "/passes/unlimited" as const;

export const bookWithEntryPackHref = (passId: string) =>
  ({
    pathname: "/book/cowork",
    params: { passId },
  }) as const;

export const unlimitedAccessHref = (passId: string) =>
  `/passes/access/${encodeURIComponent(passId)}` as const;

export const entryPackHrefForDraft = (draft: CoworkDraft) =>
  ({
    pathname: entryPackPurchaseHref,
    params: { tier: coworkPassTier(draft) },
  }) as const;

/**
 * The Unlimited purchase prefilled from the booking draft as it is now: the
 * desk tier, coffee on an Open Space draft, the chosen monitor, and the chosen
 * date as the start date. A value the draft no longer holds is left out, and
 * the purchase screen checks the start date against its own rules.
 */
export const unlimitedHrefForDraft = (draft: CoworkDraft) =>
  ({
    pathname: unlimitedPurchaseHref,
    params: {
      tier: coworkPassTier(draft),
      ...(draft.tier === "open-space" && draft.coffee && { coffee: "1" }),
      ...Option.match(draft.workstation, {
        onNone: () => ({}),
        onSome: ({ option }) => ({ monitorOption: option }),
      }),
      ...Option.match(draft.date, {
        onNone: () => ({}),
        onSome: (startDate) => ({ startDate }),
      }),
    },
  }) as const;
