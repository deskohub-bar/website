import type { WorkspaceCoworkCurrentTier } from "@/features/checkout/product-catalog";
import type { OrderId } from "@/features/order";
import type { HeldEntryPack } from "@/features/passes/backend/held-entry-packs";
import type { EntryPackSize, PassTier } from "@/features/passes/pass-offer";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { PlainDate } from "@/shared/utils/temporal";

export type BookableEntryPack = {
  readonly id: OrderId;
  readonly tier: PassTier;
  readonly entryCount: EntryPackSize;
  readonly entriesLeft: number;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
  readonly unavailableDates?: readonly PlainDate[];
};

export type CoworkEntryPacks = {
  /** Active packs with an entry left, ordered by soonest expiry. */
  readonly packs: readonly BookableEntryPack[];
  readonly claimedDates: readonly PlainDate[];
};

export const noCoworkBookingPasses: CoworkEntryPacks = {
  packs: [],
  claimedDates: [],
};

export type InitialCoworkEntryPack =
  | { readonly kind: "applied"; readonly packId: OrderId }
  | { readonly kind: "invalid-link" }
  | { readonly kind: "unavailable" };

export const getCoworkBookingPasses = (
  heldEntryPacks: readonly HeldEntryPack[],
  today: string,
  restored?: {
    readonly passId: OrderId;
    readonly reservationId: WorkspaceReservationId;
  }
): CoworkEntryPacks => {
  const claimedDates = new Set<CoworkEntryPacks["claimedDates"][number]>();
  const packs = heldEntryPacks.flatMap((pack) => {
    const editedDate =
      restored?.passId === pack.id
        ? pack.reservedEntryDates[restored.reservationId]
        : undefined;
    for (const date of pack.claimedDates) {
      if (date >= today && date !== editedDate) claimedDates.add(date);
    }
    const entriesLeft = pack.entriesLeft + Number(editedDate !== undefined);
    return pack.status === "active" &&
      (pack.giftIssuedAt === null || pack.giftClaimedAt !== null) &&
      pack.giftPaymentIsUsable &&
      entriesLeft > 0 &&
      today < pack.validUntil
      ? [
          {
            id: pack.id,
            tier: pack.tier,
            entryCount: pack.entryCount,
            entriesLeft,
            validFrom: pack.validFrom,
            validUntil: pack.validUntil,
          },
        ]
      : [];
  });
  return { packs, claimedDates: [...claimedDates] };
};

export const getEntryPackCoworkTier = (
  tier: PassTier
): WorkspaceCoworkCurrentTier =>
  tier === "open-space" ? "open-space" : "reserved-desk";

export const entryPackCoversDate = (pack: BookableEntryPack, date: string) =>
  date >= pack.validFrom && date < pack.validUntil;

export const entryPackIsAvailableOn = (pack: BookableEntryPack, date: string) =>
  entryPackCoversDate(pack, date) &&
  !pack.unavailableDates?.some((unavailableDate) => unavailableDate === date);

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
      entryPackIsAvailableOn(pack, date)
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
  while (date.toString() < pack.validUntil) {
    const day = date.toString();
    if (
      !claimedDates.some((claim) => claim === day) &&
      entryPackIsAvailableOn(pack, day)
    ) {
      return day;
    }
    date = date.add({ days: 1 });
  }
  return undefined;
};
