import { Option, Schema } from "effect";
import {
  type WorkspaceProductMonitorOption,
  type WorkspaceProductTier,
  workspaceProductMonitorOptions,
} from "@/features/checkout/product-catalog";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import { type PassTier, passTiers } from "./pass-offer";

/**
 * The pass choices a purchase link carries from a booking draft or a
 * comparison page. Every field is optional: a link names only what the
 * customer has chosen, and the purchase page fills the rest with its
 * defaults and validates what it receives.
 */
export type PassPurchaseDraft = {
  readonly tier?: PassTier;
  readonly coffee?: boolean;
  readonly monitorOption?: WorkspaceProductMonitorOption;
  readonly startDate?: PlainDate;
};

type PassPurchaseQuery = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

const decodeStartDate = Schema.decodeUnknownOption(plainDateStringSchema);

/**
 * Keeps only the add-ons the tier sells, so a link never names an add-on
 * its purchase page would ignore: coffee is optional on Open Space alone,
 * and a monitor option is what makes a Reserved Desk a workstation.
 */
export const getTierPassPurchaseDraft = (
  draft: PassPurchaseDraft,
  tier: PassTier
): PassPurchaseDraft & { readonly tier: PassTier } => ({
  tier,
  ...(tier === "open-space" && draft.coffee && { coffee: true }),
  ...(tier === "reserved-desk-workstation" &&
    draft.monitorOption && { monitorOption: draft.monitorOption }),
  ...(draft.startDate && { startDate: draft.startDate }),
});

/** Writes a draft with the purchase pages' parameter names. */
export const getPassPurchaseDraftQuery = (draft: PassPurchaseDraft) => {
  const query = new URLSearchParams();
  if (draft.tier) query.set("tier", draft.tier);
  if (draft.startDate) query.set("startDate", draft.startDate);
  if (draft.coffee) query.set("coffee", "true");
  if (draft.monitorOption) query.set("monitorOption", draft.monitorOption);
  return query;
};

/** Reads a draft a link carried, dropping values no purchase page accepts. */
export const readPassPurchaseDraft = (
  query: PassPurchaseQuery
): PassPurchaseDraft => {
  const tier = passTiers.find((candidate) => candidate === query.tier);
  const monitorOption = workspaceProductMonitorOptions.find(
    (option) => option === query.monitorOption
  );
  const startDate = Option.getOrUndefined(decodeStartDate(query.startDate));
  return {
    ...(tier && { tier }),
    ...(query.coffee === "true" && { coffee: true }),
    ...(monitorOption && { monitorOption }),
    ...(startDate && { startDate }),
  };
};

/**
 * The pass choices a cowork booking draft implies: a Reserved Desk with a
 * monitor option is the workstation tier, and the reservation date is the
 * Unlimited start date. A tier no pass covers gives no draft.
 */
export const getCoworkPassPurchaseDraft = (selection: {
  readonly entryTier: WorkspaceProductTier;
  readonly date?: string;
  readonly coffee?: boolean;
  /** The form keeps an empty choice while no monitor is picked. */
  readonly monitorOption?: WorkspaceProductMonitorOption | "";
}): (PassPurchaseDraft & { readonly tier: PassTier }) | undefined => {
  const tier =
    selection.entryTier === "reserved-desk" && selection.monitorOption
      ? "reserved-desk-workstation"
      : passTiers.find((candidate) => candidate === selection.entryTier);
  if (!tier) return undefined;
  const startDate = Option.getOrUndefined(decodeStartDate(selection.date));
  return getTierPassPurchaseDraft(
    {
      coffee: selection.coffee,
      monitorOption: selection.monitorOption || undefined,
      startDate,
    },
    tier
  );
};
