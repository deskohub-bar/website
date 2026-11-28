import type {
  CustomerPassCatalog,
  CustomerPassList,
  CustomerPassTier,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { CoworkDraft } from "../booking/selection/cowork-selection";
import { addDays, type PragueDate } from "../booking/selection/prague-date";

/** One Entry pack's visit counts, smallest first, without repeats. */
export type EntryPackSizes = readonly (5 | 10)[];

/**
 * The visit counts the Entry pack offer advertises: the sizes the catalog
 * sells for the tier, else every size it sells. Empty when it sells no pack.
 */
export const entryPackOfferSizes = (
  catalog: CustomerPassCatalog,
  tier: CustomerPassTier
): EntryPackSizes => {
  const sizes = (packs: CustomerPassCatalog["entryPacks"]) =>
    [...new Set(packs.map(({ product }) => product.size))].sort(
      (first, second) => first - second
    );
  const forTier = sizes(
    catalog.entryPacks.filter(({ product }) => product.tier === tier)
  );
  return forTier.length > 0 ? forTier : sizes(catalog.entryPacks);
};

/**
 * The Unlimited offer for the tier, else the catalog's first one; undefined
 * when the catalog sells no Unlimited pass.
 */
export const unlimitedOffer = (
  catalog: CustomerPassCatalog,
  tier: CustomerPassTier
) =>
  catalog.unlimited.find(({ product }) => product.tier === tier) ??
  catalog.unlimited[0];

/**
 * The expiry an Unlimited pass bought from the draft would show: from the
 * draft's date, else today in Prague, plus the pass's validity in calendar
 * days.
 */
export const unlimitedOfferExpiry = (
  draft: CoworkDraft,
  today: PragueDate,
  validityDays: number
): PragueDate =>
  addDays(
    Option.getOrElse(draft.date, () => today),
    validityDays
  );

/** Whether the customer holds an Unlimited pass that is active or upcoming. */
export const holdsCurrentUnlimitedPass = (held: CustomerPassList["held"]) =>
  held.some(
    (pass) =>
      pass.kind === "unlimited" &&
      (pass.status === "active" || pass.status === "upcoming")
  );

/**
 * The catalog the Cowork form offers passes from, or undefined while the
 * offers stay hidden: an Entry pack is applied, a held pack can pay for the
 * booking (its banner offers it), the customer holds an active or upcoming
 * Unlimited pass, or either pass read hasn't succeeded. A catalog read
 * failing as unavailable is the passes rollout switched off.
 */
export const coworkPassOfferCatalog = ({
  appliedPackId,
  catalog,
  heldPasses,
}: {
  readonly appliedPackId: string | undefined;
  readonly catalog: AsyncResult.AsyncResult<CustomerPassCatalog, unknown>;
  readonly heldPasses: AsyncResult.AsyncResult<
    Pick<CustomerPassList, "held">,
    unknown
  >;
}): CustomerPassCatalog | undefined =>
  appliedPackId === undefined &&
  AsyncResult.isSuccess(catalog) &&
  AsyncResult.isSuccess(heldPasses) &&
  !heldPasses.value.held.some(
    (pass) => pass.kind === "entry-pack" && pass.bookFrom !== undefined
  ) &&
  !holdsCurrentUnlimitedPass(heldPasses.value.held)
    ? catalog.value
    : undefined;
