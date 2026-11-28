import type { PressableProps } from "react-native";

type KeyDownEvent = Parameters<NonNullable<PressableProps["onKeyDown"]>>[0];

/**
 * The `onKeyDown` of a `role="link"` control that opens through `onPress`:
 * Enter follows it, as on a web anchor. React Native Web presses a link only
 * on click, leaving Enter to the browser, which follows only an `href`.
 */
export const followLinkOnEnter =
  (follow: () => void) => (event: KeyDownEvent) => {
    if (event.nativeEvent.key !== "Enter") return;
    event.preventDefault();
    follow();
  };
