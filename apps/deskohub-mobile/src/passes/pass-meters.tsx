import { StyleSheet, View } from "react-native";
import { Text } from "../ui/text";
import { color, radius, space } from "../ui/tokens";

export type MeterPart = "spent" | "now" | "left";

const fill = {
  spent: color.outline,
  now: color.action,
  left: color.positive,
} as const satisfies Record<MeterPart, string>;

/** One segment per entry (or day), in order: spent, now, left. */
export function SegmentMeter({
  spent,
  now,
  left,
  thin = false,
  label,
}: {
  readonly spent: number;
  readonly now: number;
  readonly left: number;
  /** The 30-day meter: thinner segments, closer together. */
  readonly thin?: boolean;
  readonly label: string;
}) {
  const parts: ReadonlyArray<MeterPart> = [
    ...Array<MeterPart>(spent).fill("spent"),
    ...Array<MeterPart>(now).fill("now"),
    ...Array<MeterPart>(left).fill("left"),
  ];
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      aria-label={label}
      style={[styles.meter, thin && styles.meterThin]}
    >
      {parts.map((part, index) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
          key={index}
          style={[
            styles.segment,
            thin && styles.segmentThin,
            { backgroundColor: fill[part] },
          ]}
        />
      ))}
    </View>
  );
}

/** The meter's key: a dot per colour and what it counts. */
export function MeterLegend({
  items,
}: {
  readonly items: ReadonlyArray<{
    readonly part: MeterPart;
    readonly label: string;
  }>;
}) {
  return (
    <View style={styles.legend}>
      {items.map(({ part, label }) => (
        <View key={label} style={styles.legendItem}>
          <View style={[styles.dot, { backgroundColor: fill[part] }]} />
          <Text variant="hint" tone="muted">
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { columnGap: 4, flexDirection: "row" },
  meterThin: { columnGap: 2 },
  segment: { borderRadius: radius.pill, flex: 1, height: 8 },
  segmentThin: { height: 8 },
  legend: {
    columnGap: space.md,
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: space.sm,
    rowGap: space.xs,
  },
  legendItem: { alignItems: "center", columnGap: 6, flexDirection: "row" },
  dot: { borderRadius: 4, height: 8, width: 8 },
});
