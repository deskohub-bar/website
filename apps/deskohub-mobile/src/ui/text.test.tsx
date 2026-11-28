import { describe, expect, test } from "bun:test";
import { Platform, StyleSheet } from "react-native";
import { elementTree, hostTree } from "./testing/element-tree";
import { Text } from "./text";
import { color, typeScale } from "./tokens";

const drawn = (props: Parameters<typeof Text>[0]) => {
  const node = hostTree(elementTree(Text, props)) as {
    readonly props: { readonly style: unknown };
  };
  return StyleSheet.flatten(node.props.style as never) as Record<
    string,
    unknown
  >;
};

describe("Text", () => {
  test("a variant draws its step of the type scale in navy", () => {
    expect(drawn({ variant: "title", children: "x" })).toMatchObject({
      ...typeScale.title,
      color: color.navy,
    });
  });

  test("supporting variants default to the muted tone", () => {
    expect(drawn({ variant: "bodySmall", children: "x" }).color).toBe(
      color.ink2
    );
  });

  test("a tone colours the text, and the caller's style still wins", () => {
    expect(
      drawn({ variant: "body", tone: "danger", children: "x" }).color
    ).toBe(color.dangerInk);
    expect(
      drawn({
        variant: "body",
        tone: "danger",
        style: { color: "#123456" },
        children: "x",
      }).color
    ).toBe("#123456");
  });

  test("numeric text uses tabular figures", () => {
    expect(
      drawn({ variant: "body", numeric: true, children: "1" }).fontVariant
    ).toEqual(["tabular-nums"]);
  });

  test("balanced text evens its lines on Android and the web", () => {
    const host = (props: Parameters<typeof Text>[0]) =>
      hostTree(elementTree(Text, props)) as {
        readonly props: Readonly<Record<string, unknown>>;
      };
    expect(
      host({ balanced: true, children: "x" }).props.textBreakStrategy
    ).toBe("balanced");
    const platform = Platform as { OS: string };
    const os = platform.OS;
    try {
      platform.OS = "web";
      expect(
        drawn({ variant: "body", balanced: true, children: "x" }).textWrap
      ).toBe("balance");
    } finally {
      platform.OS = os;
    }
  });

  test("without a variant or tone the caller's style passes through as it is", () => {
    const style = { marginTop: 4 };
    const node = hostTree(elementTree(Text, { style, children: "x" })) as {
      readonly props: { readonly style: unknown };
    };
    expect(node.props.style).toBe(style);
  });
});
