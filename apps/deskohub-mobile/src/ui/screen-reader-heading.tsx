import { StyleSheet } from "react-native";
import { Text } from "./text";

/**
 * A heading only assistive tech reads: it names a group of content the
 * screen shows without a visible title. It takes no space and draws nothing.
 */
export function ScreenReaderHeading({
  children,
}: {
  readonly children: string;
}) {
  return (
    <Text role="heading" style={styles.hidden}>
      {children}
    </Text>
  );
}

// A 1 dp clipped box, not opacity 0 or display none: VoiceOver skips
// transparent views, and both platforms skip views that aren't displayed.
const styles = StyleSheet.create({
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    color: "transparent",
  },
});
