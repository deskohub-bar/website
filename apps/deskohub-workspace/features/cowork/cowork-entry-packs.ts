import type { WorkspaceCoworkCurrentTier } from "@/features/checkout/product-catalog";
import type { OrderId } from "@/features/order";
import type { EntryPackSize, PassTier } from "@/features/passes/pass-offer";
import type { PlainDate } from "@/shared/utils/temporal";

export type BookableEntryPack = {
  readonly id: OrderId;
  readonly tier: PassTier;
  readonly entryCount: EntryPackSize;
  readonly entriesLeft: number;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
};

export type CoworkEntryPacks = {
  /** Active packs with an entry left, ordered by soonest expiry. */
  readonly packs: readonly BookableEntryPack[];
  readonly claimedDates: readonly PlainDate[];
};

export type InitialCoworkEntryPack =
  | { readonly kind: "applied"; readonly packId: OrderId }
  | { readonly kind: "invalid-link" }
  | { readonly kind: "unavailable" };

export const getEntryPackCoworkTier = (
  tier: PassTier
): WorkspaceCoworkCurrentTier =>
  tier === "open-space" ? "open-space" : "reserved-desk";

export const entryPackCoversDate = (pack: BookableEntryPack, date: string) =>
  date >= pack.validFrom && date < pack.validUntil;

export const getOfferedEntryPack = (
  { packs, claimedDates }: CoworkEntryPacks,
  {
    date,
    excludedPackId,
    tier,
    workstation,
    workstationRequired,
  }: {
    readonly date: string;
    readonly excludedPackId?: OrderId;
    readonly tier: WorkspaceCoworkCurrentTier;
    readonly workstation: boolean;
    readonly workstationRequired: boolean;
  }
) => {
  if (claimedDates.some((claimedDate) => claimedDate === date))
    return undefined;

  const selectedTier =
    tier === "reserved-desk" && workstation
      ? "reserved-desk-workstation"
      : tier;

  return packs.find(
    (pack) =>
      pack.id !== excludedPackId &&
      (pack.tier === selectedTier ||
        (selectedTier === "reserved-desk-workstation" &&
          workstationRequired &&
          pack.tier === "reserved-desk")) &&
      entryPackCoversDate(pack, date)
  );
};

export const firstEntryPackDate = (
  pack: BookableEntryPack,
  today: string,
  claimedDates: readonly PlainDate[]
) => {
  let date = Temporal.PlainDate.from(
    today > pack.validFrom ? today : pack.validFrom
  );
  while (claimedDates.some((claim) => claim === date.toString())) {
    date = date.add({ days: 1 });
  }
  return entryPackCoversDate(pack, date.toString())
    ? date.toString()
    : undefined;
};
