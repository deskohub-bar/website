import ChevronRight from "lucide-react-native/icons/chevron-right";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Icon } from "../ui/icon";
import { Text } from "../ui/text";
import { space } from "../ui/tokens";

/** A pass offer card's action: its label and a chevron, in the card's colour. */
export function PassOfferAction({
  label,
  color,
  style,
}: {
  readonly label: string;
  readonly color: string;
  readonly style?: ViewStyle;
}) {
  return (
    <View style={[styles.action, style]}>
      <Text variant="buttonSmall" style={[styles.label, { color }]} balanced>
        {label}
      </Text>
      <Icon icon={ChevronRight} size={14} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: space.xs,
  },
  label: { flexShrink: 1 },
});
