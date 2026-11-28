import type { CustomerPassList } from "@deskohub/workspace-customer-api";
import type { ReservationListRow } from "./reservation-list-model";

/** A pass the account holds, as GET /passes lists it. */
type HeldPass = CustomerPassList["held"][number];

/** What decides whether the Past group offers packs and passes. */
export interface SavingsOfferFacts {
  /** The Past group's rows, read fresh from the Workspace. */
  readonly past: ReadonlyArray<ReservationListRow>;
  /**
   * The passes the account holds; undefined while the pass rollout is closed
   * or the read hasn't succeeded.
   */
  readonly held: ReadonlyArray<HeldPass> | undefined;
}

/**
 * Whether a pass still covers the account's next visits: an Entry pack
 * while it can book (the Workspace gives a usable pack, its gift claimed
 * and paid, a first date to book from), an Unlimited pass until it ends.
 */
const covers = (pass: HeldPass): boolean =>
  pass.kind === "entry-pack"
    ? pass.status === "active" &&
      pass.entriesLeft > 0 &&
      pass.bookFrom !== undefined
    : pass.status === "active" || pass.status === "upcoming";

/**
 * A paid coworking visit of the account's own: confirmed, not one it booked
 * for someone else (one booked for it by another account counts), and
 * settled with money the customer kept paying: not free, refunded, or from
 * a pass. A Dotypos-only row has no settlement, so it never counts.
 */
const isPaidOwnCoworkVisit = (row: ReservationListRow): boolean =>
  row.product.kind === "cowork" &&
  row.status === "confirmed" &&
  row.party?.kind !== "booked-for" &&
  row.settlement === "paid";

/**
 * Whether the Past group ends with the packs and passes offer (board 06): a
 * coworking visit paid individually, and no pass covering the next ones.
 * The same rule as the site's past reservations.
 */
export const showsSavingsOffer = ({ past, held }: SavingsOfferFacts): boolean =>
  held !== undefined && !held.some(covers) && past.some(isPaidOwnCoworkVisit);
