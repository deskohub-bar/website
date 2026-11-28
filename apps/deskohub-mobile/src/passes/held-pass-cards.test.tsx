import { expect, spyOn, test } from "bun:test";
import type { CustomerHeldEntryPack } from "@deskohub/workspace-customer-api";
import * as ReactNative from "react-native";
import { AppLocaleProvider } from "../i18n/locale-context";
import { findAll, hostTree, textOf } from "../ui/testing/element-tree";
import { HeldEntryPackCard } from "./held-pass-cards";

const pack = {
  kind: "entry-pack",
  tier: "open-space",
  status: "active",
  size: 5,
  passId: "642ef6b9-48aa-495f-83a8-9a53f4791692",
  boughtOn: "2026-11-20",
  validFrom: "2026-11-21",
  lastUsableDate: "2027-01-31",
  bookFrom: "2026-11-21",
  bookedDates: [],
  entriesLeft: 5,
} satisfies CustomerHeldEntryPack;

test("wide cards keep a fitting pass label together while purchase details stack at large text", () => {
  const dimensions = spyOn(ReactNative, "useWindowDimensions").mockReturnValue({
    width: 1280,
    height: 800,
    fontScale: 1.3,
    scale: 2,
  });
  try {
    const tree = hostTree(
      <HeldEntryPackCard pack={pack} onBook={() => undefined} />,
      (node) => <AppLocaleProvider locale="en-US">{node}</AppLocaleProvider>
    );
    const labels = findAll(tree, "Text").map(textOf);
    expect(labels).toContain("Entry pack · 5 entries");
    expect(labels.some((label) => label.startsWith("Bought "))).toBe(true);
  } finally {
    dimensions.mockRestore();
  }
});
