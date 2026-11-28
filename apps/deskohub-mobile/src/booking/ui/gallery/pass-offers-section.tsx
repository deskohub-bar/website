import type { CustomerPassCatalog } from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import { PassOfferCards } from "../../../passes/pass-offer-cards";
import { GalleryCase, GallerySection } from "../../../ui/gallery/gallery-kit";
import { ScrollScreen } from "../../../ui/scroll-screen";
import type { CoworkDraft } from "../../selection/cowork-selection";
import { czk } from "../../testing/sample-booking-catalog";

const tiers = [
  "open-space",
  "reserved-desk",
  "reserved-desk-workstation",
] as const;

/** Every tier sells both pack sizes and an Unlimited pass, as production does. */
const catalog: CustomerPassCatalog = {
  entryPacks: tiers.flatMap((tier) =>
    ([5, 10] as const).map((size) => ({
      product: { kind: "entry-pack" as const, tier, size },
      price: czk(size * 300),
      validityMonths: 3,
    }))
  ),
  unlimited: tiers.map((tier) => ({
    product: { kind: "unlimited" as const, tier },
    price: czk(5490),
    validityDays: 30,
  })),
  unlimitedCoffeePrice: czk(490),
};

const reservedDesk: CoworkDraft = {
  tier: "reserved-desk",
  stay: "day",
  date: Option.none(),
  coffee: false,
  workstation: Option.none(),
};
const openSpaceDated: CoworkDraft = {
  ...reservedDesk,
  tier: "open-space",
  date: Option.some("2026-11-27"),
  coffee: true,
};
const today = "2026-11-22";

/** Board 05's pass offers, as the end of the Cowork booking form shows them. */
export function PassOffersGallerySection() {
  return (
    <ScrollScreen>
      <GallerySection title="Pass offers">
        <GalleryCase label="Reserved Desk, no date yet">
          <PassOfferCards
            catalog={catalog}
            draft={reservedDesk}
            today={today}
          />
        </GalleryCase>
        <GalleryCase label="Open Space with a date">
          <PassOfferCards
            catalog={catalog}
            draft={openSpaceDated}
            today={today}
          />
        </GalleryCase>
        <GalleryCase label="Only Entry packs on sale, one size">
          <PassOfferCards
            catalog={{
              ...catalog,
              entryPacks: catalog.entryPacks.filter(
                ({ product }) => product.size === 10
              ),
              unlimited: [],
            }}
            draft={reservedDesk}
            today={today}
          />
        </GalleryCase>
      </GallerySection>
    </ScrollScreen>
  );
}
