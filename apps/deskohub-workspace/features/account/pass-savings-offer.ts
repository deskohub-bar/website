import type { AccountPasses } from "./account-passes.server";
import type { AccountUnlimitedPasses } from "./account-unlimited-passes.server";
import type { CustomerReservationSummary } from "./contracts";

/**
 * A completed coworking visit of the customer's own, paid for one visit at a
 * time: confirmed, past, and settled with money the customer kept paying,
 * not free, refunded, or from an Entry pack or an Unlimited pass. Another
 * account may have booked it for the customer; a visit this account booked
 * for another customer isn't its own.
 */
const isPaidOwnCoworkVisit = (reservation: CustomerReservationSummary) =>
  reservation.product.kind === "cowork" &&
  reservation.status === "confirmed" &&
  reservation.party?.kind !== "booked-for" &&
  reservation.settlement === "paid";

/**
 * Whether the Past reservations section offers Entry packs and Unlimited
 * passes: after a completed visit the customer paid for on its own, while it
 * holds no Entry pack it can book with and no active or upcoming Unlimited
 * pass. Coverage that couldn't be read keeps the offer hidden.
 *
 * `past` is the history's past group, whose rows already ended or were
 * cancelled.
 */
export const offersPassSavings = ({
  past,
  entryPacks,
  unlimitedPasses,
}: {
  readonly past: readonly CustomerReservationSummary[];
  readonly entryPacks: AccountPasses;
  readonly unlimitedPasses: AccountUnlimitedPasses;
}): boolean =>
  entryPacks !== "unavailable" &&
  unlimitedPasses !== "unavailable" &&
  past.some(isPaidOwnCoworkVisit) &&
  // An Entry pack covers the customer while it can book: active with entries
  // left, claimed if it was a gift, and paid. Its account view sets
  // `bookPath` exactly then.
  !entryPacks.held.some((pack) => pack.bookPath !== undefined) &&
  !unlimitedPasses.some(
    (pass) => pass.status === "active" || pass.status === "upcoming"
  );
