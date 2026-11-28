import { describe, expect, test } from "bun:test";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import CircleCheck from "lucide-react-native/icons/circle-check";
import Globe from "lucide-react-native/icons/globe";
import Info from "lucide-react-native/icons/info";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { isValidElement, type ReactElement } from "react";
import { Icon } from "./icon";
import { Notice } from "./notice";
import {
  elementTree,
  find,
  findAll,
  flatStyle,
  type HostProps,
} from "./testing/element-tree";
import { Text } from "./text";

const notice = (props: Parameters<typeof Notice>[0]) =>
  elementTree(Notice, props) as ReactElement<HostProps>;

/** The notice's live region: its Text with a role. */
const region = (props: Parameters<typeof Notice>[0]) =>
  findAll(notice(props), Text).find((text) => text.props.role !== undefined)
    ?.props;

describe("Notice", () => {
  test("idle, it keeps its live region mounted out of the flow", () => {
    for (const message of [undefined, ""]) {
      const tree = notice({
        tone: "error",
        message,
        title: "t",
        action: { label: "a", onPress: () => undefined },
      });
      expect(flatStyle(tree.props.style)).toMatchObject({
        position: "absolute",
        overflow: "hidden",
        width: 1,
        height: 1,
      });
      expect(find(tree, Icon)).toBeUndefined();
      expect(find(tree, "Pressable")).toBeUndefined();
      const live = region({ tone: "error", message });
      expect(live).toMatchObject({
        role: "alert",
        "aria-live": "assertive",
        accessibilityLiveRegion: "assertive",
      });
      expect(region({ tone: "info", message })).toMatchObject({
        role: "status",
        "aria-live": "polite",
        accessibilityLiveRegion: "polite",
      });
    }
  });

  test("each tone shows its own icon; an icon of the caller's replaces it", () => {
    const icon = (props: Parameters<typeof Notice>[0]) =>
      find<Parameters<typeof Icon>[0]>(notice(props), Icon)?.props.icon;
    expect(icon({ tone: "info", message: "m" })).toBe(Info);
    expect(icon({ tone: "positive", message: "m" })).toBe(CircleCheck);
    expect(icon({ tone: "warning", message: "m" })).toBe(TriangleAlert);
    expect(icon({ tone: "error", message: "m" })).toBe(CircleAlert);
    expect(icon({ tone: "info", message: "m", icon: Globe })).toBe(Globe);
  });

  test("errors are assertive alerts; the other tones polite statuses", () => {
    for (const tone of ["info", "positive", "warning"] as const) {
      const live = region({ tone, message: "m" });
      expect(live?.role).toBe("status");
      expect(live?.["aria-live"]).toBe("polite");
      expect(live?.accessibilityLiveRegion).toBe("polite");
    }
    const error = region({ tone: "error", message: "m" });
    expect(error?.role).toBe("alert");
    expect(error?.["aria-live"]).toBe("assertive");
    expect(error?.accessibilityLiveRegion).toBe("assertive");
  });

  test("a title is part of the live region, before the message", () => {
    const titleIndex = (props: Parameters<typeof Notice>[0]) =>
      (
        region(props)?.children as ReadonlyArray<unknown> | undefined
      )?.findIndex((child) => isValidElement(child) && child.type === Text);
    const children = region({ tone: "error", message: "m", title: "t" })
      ?.children as ReadonlyArray<unknown>;
    expect(titleIndex({ tone: "error", message: "m", title: "t" })).toBe(0);
    expect(children.indexOf("m")).toBe(1);
    expect(titleIndex({ tone: "error", message: "m" })).toBe(-1);
  });

  test("an action is a button that runs its handler", () => {
    let pressed = 0;
    const button = find(
      notice({
        tone: "error",
        message: "m",
        action: { label: "a", onPress: () => pressed++ },
      }),
      "Pressable"
    )?.props;
    expect(button?.role).toBe("button");
    (button?.onPress as (() => void) | undefined)?.();
    expect(pressed).toBe(1);
  });
});
