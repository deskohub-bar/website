import Info from "lucide-react-native/icons/info";
import { type ComponentRef, type ReactNode, useRef } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import type { tierArtwork } from "../../../booking/family/cowork-tier-cards";
import { choiceIndexForKey, tabStopIndex } from "../../../ui/choice-group-keys";
import { Icon, type IconComponent } from "../../../ui/icon";
import { RadioMark, radioCardStyle } from "../../../ui/radio-card";
import { Text } from "../../../ui/text";
import { color, radius, space } from "../../../ui/tokens";

type Choice<Value> = {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
  readonly artwork?: ReturnType<typeof tierArtwork>;
  readonly content: ReactNode;
};

/** Pass choices have the radio mark on the right and use the full card as a target. */
export function ChooseCards<Value extends string | number>({
  label,
  options,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<Choice<Value>>;
  readonly selected: Value | undefined;
  readonly onSelect: (value: Value) => void;
}) {
  const refs = useRef(new Map<Value, ComponentRef<typeof Pressable>>());
  const enabled = options
    .filter(({ disabled }) => !disabled)
    .map(({ value }) => value);
  const tabStop = enabled[tabStopIndex(enabled, selected)];

  return (
    <View role="radiogroup" aria-label={label} style={styles.group}>
      {options.map(
        ({ value, label: title, disabled = false, artwork, content }) => {
          const checked = value === selected;
          const select = (next: Value) => {
            if (next !== selected) onSelect(next);
          };
          return (
            <Pressable
              key={value}
              ref={(node) => {
                if (node) refs.current.set(value, node);
                else refs.current.delete(value);
              }}
              role="radio"
              aria-checked={checked}
              aria-disabled={disabled}
              disabled={disabled}
              tabIndex={value === tabStop ? 0 : -1}
              onPress={disabled ? undefined : () => select(value)}
              onKeyDown={(event) => {
                if (disabled) return;
                const index = choiceIndexForKey(
                  event.nativeEvent.key,
                  enabled.indexOf(value),
                  enabled.length
                );
                const next = index === undefined ? undefined : enabled[index];
                if (next === undefined) return;
                event.preventDefault();
                refs.current.get(next)?.focus();
                select(next);
              }}
              style={({ pressed }) => [
                radioCardStyle({ checked, disabled, pressed }),
                styles.card,
                artwork && styles.illustratedCard,
              ]}
            >
              {artwork && (
                <View
                  aria-hidden
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  pointerEvents="none"
                  style={styles.artFrame}
                >
                  <Image
                    source={artwork.source}
                    resizeMode="contain"
                    style={[styles.art, { aspectRatio: artwork.aspectRatio }]}
                  />
                </View>
              )}
              <View style={styles.heading}>
                <Text
                  variant={artwork ? "title" : "headline"}
                  style={[styles.title, disabled && styles.disabledTitle]}
                >
                  {title}
                </Text>
                <RadioMark checked={checked} disabled={disabled} />
              </View>
              {content}
            </Pressable>
          );
        }
      )}
    </View>
  );
}

export function ChooseNote({
  icon = Info,
  children,
}: {
  readonly icon?: IconComponent;
  readonly children: string;
}) {
  return (
    <View style={styles.note}>
      <Icon icon={icon} size={16} color={color.action} />
      <Text variant="hint" tone="muted" style={styles.noteText}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: space.sm,
    marginTop: space.md,
  },
  noteText: { flex: 1 },

  group: { gap: space.sm },
  card: {
    alignItems: "stretch",
    borderRadius: radius.group,
    flexDirection: "column",
    gap: space.xxs,
    overflow: "hidden",
  },
  illustratedCard: { gap: space.sm, minHeight: 148 },
  heading: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: space.md,
    justifyContent: "space-between",
  },
  title: { flexShrink: 1 },
  disabledTitle: { color: color.disabledInk },
  artFrame: {
    alignItems: "flex-end",
    bottom: 0,
    justifyContent: "center",
    left: "46%",
    position: "absolute",
    right: 0,
    top: 0,
  },
  art: { height: "100%", maxWidth: "100%", width: undefined },
});
