import type { CustomerHeldEntryPack } from "@deskohub/workspace-customer-api";
import Check from "lucide-react-native/icons/check";
import Ticket from "lucide-react-native/icons/ticket";
import { StyleSheet, View } from "react-native";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { Button } from "../ui/controls";
import { Icon } from "../ui/icon";
import { Text } from "../ui/text";
import { color, radius, space } from "../ui/tokens";
import { SegmentMeter } from "./pass-meters";

export function EntryPackBanner({
  pack,
  applied,
  onApply,
  onPayByCard,
}: {
  readonly pack?: CustomerHeldEntryPack | undefined;
  readonly applied: boolean;
  readonly onApply: () => void;
  readonly onPayByCard: () => void;
}) {
  const locale = useAppLocale();
  const usedNow = applied && pack !== undefined && pack.entriesLeft > 0 ? 1 : 0;
  const remaining = pack === undefined ? 0 : pack.entriesLeft - usedNow;
  const count = applied
    ? m.booking_pass_left_after({ count: remaining }, { locale })
    : m.booking_pass_left(
        { count: remaining, size: pack?.size ?? 0 },
        { locale }
      );
  return (
    <View style={[styles.banner, applied ? styles.applied : styles.offer]}>
      <View style={styles.head}>
        <View
          style={[styles.disc, applied ? styles.discApplied : styles.discOffer]}
        >
          <Icon
            icon={applied ? Check : Ticket}
            size={20}
            color={applied ? color.onPositive : color.white}
          />
        </View>
        <View style={styles.text}>
          <Text variant="headline">
            {applied
              ? m.booking_pass_applied({}, { locale })
              : m.booking_pass_offer({}, { locale })}
          </Text>
          {pack !== undefined && (
            <View style={styles.meterRow}>
              <View style={styles.meter}>
                <SegmentMeter
                  spent={pack.size - pack.entriesLeft}
                  now={usedNow}
                  left={remaining}
                  label={count}
                />
              </View>
              <Text variant="label" numeric>
                {count}
              </Text>
            </View>
          )}
        </View>
      </View>
      {applied ? (
        <Button
          label={m.booking_pass_card_instead({}, { locale })}
          variant="secondary"
          onPress={onPayByCard}
        />
      ) : (
        <Button
          label={m.booking_pass_use({}, { locale })}
          icon={Ticket}
          onPress={onApply}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: radius.group,
    borderWidth: 1,
    gap: space.lg,
    padding: space.lg,
  },
  offer: { backgroundColor: color.actionTint, borderColor: color.action },
  applied: { backgroundColor: color.positiveTint, borderColor: color.positive },
  head: { columnGap: space.md, flexDirection: "row" },
  disc: {
    alignItems: "center",
    borderRadius: 20,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  discOffer: { backgroundColor: color.action },
  discApplied: { backgroundColor: color.positive },
  text: { flex: 1, gap: space.sm },
  meterRow: {
    alignItems: "center",
    columnGap: space.md,
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.xs,
  },
  meter: { flexBasis: 96, flexGrow: 1, maxWidth: 160 },
});
