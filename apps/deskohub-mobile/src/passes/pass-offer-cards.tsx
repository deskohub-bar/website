import type { CustomerPassCatalog } from "@deskohub/workspace-customer-api";
import { useRouter } from "expo-router";
import { Platform, StyleSheet, View } from "react-native";
import Svg, { Line } from "react-native-svg";
import type { CoworkDraft } from "../booking/selection/cowork-selection";
import type { PragueDate } from "../booking/selection/prague-date";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { iconHiddenProps } from "../ui/icon";
import { ScreenReaderHeading } from "../ui/screen-reader-heading";
import { color, space } from "../ui/tokens";
import { useViewport, wideGutter } from "../ui/viewport";
import { coworkPassTier } from "./entry-pack-booking";
import { passDate } from "./pass-copy";
import { UnlimitedCredential } from "./pass-offer-credential";
import { EntryPackTicket } from "./pass-offer-ticket";
import {
  entryPackOfferSizes,
  unlimitedOffer,
  unlimitedOfferExpiry,
} from "./pass-offers";
import { entryPackHrefForDraft, unlimitedHrefForDraft } from "./pass-routes";

/**
 * The Entry pack and Unlimited pass offers at the end of the Cowork booking
 * form, under a dotted rule. Each card shows while the catalog sells its
 * product and the draft is a day visit, and opens its purchase prefilled from
 * the draft as it is when pressed.
 */
export function PassOfferCards({
  catalog,
  draft,
  today,
}: {
  readonly catalog: CustomerPassCatalog;
  readonly draft: CoworkDraft;
  readonly today: PragueDate;
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const tier = coworkPassTier(draft);
  const sizes = entryPackOfferSizes(catalog, tier);
  const unlimited = unlimitedOffer(catalog, tier);
  // As on the site, an overnight stay shows no pass offers.
  if (draft.stay === "overnight") return null;
  if (sizes.length === 0 && unlimited === undefined) return null;
  return (
    <View style={styles.offers}>
      <DottedRule />
      <ScreenReaderHeading>
        {m.passes_offers_heading({}, { locale })}
      </ScreenReaderHeading>
      <View style={styles.cards}>
        {sizes.length > 0 && (
          <EntryPackTicket
            sizes={sizes}
            onPress={() => router.push(entryPackHrefForDraft(draft))}
          />
        )}
        {unlimited !== undefined && (
          <UnlimitedCredential
            tagline={
              unlimited.product.tier === "open-space"
                ? m.passes_offer_unlimited_access(
                    { days: unlimited.validityDays },
                    { locale }
                  )
                : m.passes_offer_unlimited_seat({}, { locale })
            }
            expiry={passDate(
              unlimitedOfferExpiry(draft, today, unlimited.validityDays),
              locale
            )}
            onPress={() => router.push(unlimitedHrefForDraft(draft))}
          />
        )}
      </View>
    </View>
  );
}

/**
 * The 2 dp dotted rule across the booking form's full width, its gutters
 * included (the booking step's scroll content sits on the screen gutter).
 */
function DottedRule() {
  const { isWide } = useViewport();
  return (
    <View
      style={[
        styles.rule,
        { marginHorizontal: -(isWide ? wideGutter : space.gutter) },
      ]}
    >
      <Svg width="100%" height={2} {...iconHiddenProps(Platform.OS)}>
        <Line
          x1="0"
          y1="1"
          x2="100%"
          y2="1"
          stroke={color.offerRule}
          strokeWidth={2}
          strokeDasharray="2 2"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  offers: { paddingBottom: space.lg, paddingTop: space.md },
  rule: { marginBottom: space.md },
  cards: { gap: 10 },
});
