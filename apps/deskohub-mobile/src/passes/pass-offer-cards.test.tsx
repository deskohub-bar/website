import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { CustomerPassCatalog } from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import type { ReactElement, ReactNode } from "react";
import * as ReactNative from "react-native";
import {
  type CoworkDraft,
  selectCoworkDate,
  selectCoworkTier,
  selectCoworkWorkstation,
} from "../booking/selection/cowork-selection";
import { AppLocaleProvider } from "../i18n/locale-context";
import { expoRouterStandIn } from "../testing/expo-router-stand-in";
import {
  findAll,
  flatStyle,
  type HostProps,
  hostTree,
  textOf,
} from "../ui/testing/element-tree";
import { color } from "../ui/tokens";

const push = mock((_href: unknown) => undefined);
mock.module("expo-router", () =>
  expoRouterStandIn({ useRouter: () => ({ push }) as never })
);

const { PassOfferCards } = await import("./pass-offer-cards");
const { EntryPackOfferLink } = await import("./entry-pack-offer-link");

const prices = (value: number) => ({ value, exponent: 2, currency: "CZK" });
const catalog: CustomerPassCatalog = {
  entryPacks: [5, 10].flatMap((size) =>
    (["open-space", "reserved-desk", "reserved-desk-workstation"] as const).map(
      (tier) => ({
        product: { kind: "entry-pack" as const, tier, size: size as 5 | 10 },
        price: prices(size * 30000),
        validityMonths: 3,
      })
    )
  ),
  unlimited: (
    ["open-space", "reserved-desk", "reserved-desk-workstation"] as const
  ).map((tier) => ({
    product: { kind: "unlimited" as const, tier },
    price: prices(549000),
    validityDays: 30,
  })),
  unlimitedCoffeePrice: prices(49000),
};
const openSpace: CoworkDraft = {
  tier: "open-space",
  stay: "day",
  date: Option.none(),
  coffee: false,
  workstation: Option.none(),
};
const today = "2026-11-22";

const render = (
  props: Partial<Parameters<typeof PassOfferCards>[0]>
): ReactElement<HostProps> =>
  hostTree(
    <PassOfferCards
      catalog={catalog}
      draft={openSpace}
      today={today}
      {...props}
    />,
    (node) => <AppLocaleProvider locale="en-US">{node}</AppLocaleProvider>
  ) as ReactElement<HostProps>;

/** The cards' links in order, as the customer meets them. */
const links = (tree: ReactNode) =>
  findAll(tree, "Pressable").filter(({ props }) => props.role === "link");

const press = (link: ReactElement<HostProps> | undefined) => {
  if (link === undefined) throw new Error("No link to press");
  (link.props.onPress as () => void)();
  return push.mock.calls.at(-1)?.[0];
};

beforeEach(() => push.mockClear());

test("the offers open with a dotted rule and a heading only screen readers read", () => {
  const tree = render({});
  const rule = findAll(tree, "Line")[0];
  expect(rule?.props.stroke).toBe(color.offerRule);
  expect(rule?.props.strokeDasharray).toBeDefined();
  const headings = findAll(tree, "Text").filter(
    ({ props }) => props.role === "heading"
  );
  expect(headings).toHaveLength(1);
  expect(textOf(headings[0] as ReactElement<HostProps>)).toBe(
    "Packs and memberships"
  );
  const labels = findAll(tree, "Text").map(textOf);
  expect(labels).toContain("Membership");
  expect(labels).toContain("Open Space access for 30 days");
  expect(labels).toContain("Choose membership");
  expect(links(tree)).toHaveLength(2);
});

test("every label on both cards balances its wrapped lines", () => {
  const labels = findAll(render({}), "Text").filter(
    ({ props }) => props.role !== "heading"
  );
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(label.props.textBreakStrategy).toBe("balanced");
  }
});

test("each card shows only while the catalog sells its product", () => {
  expect(
    links(render({ catalog: { ...catalog, unlimited: [] } }))
  ).toHaveLength(1);
  expect(
    press(links(render({ catalog: { ...catalog, unlimited: [] } }))[0])
  ).toMatchObject({ pathname: "/passes/entry-pack" });
  expect(
    press(links(render({ catalog: { ...catalog, entryPacks: [] } }))[0])
  ).toMatchObject({ pathname: "/passes/unlimited" });
  const empty = hostTree(
    <PassOfferCards
      catalog={{ ...catalog, entryPacks: [], unlimited: [] }}
      draft={openSpace}
      today={today}
    />,
    (node) => <AppLocaleProvider locale="en-US">{node}</AppLocaleProvider>
  );
  expect(empty).toBeNull();
  expect(
    render({
      draft: {
        ...selectCoworkTier(openSpace, "reserved-desk"),
        stay: "overnight",
      },
    })
  ).toBeNull();
});

test("each card opens its purchase with the draft as it is when pressed", () => {
  const withCoffee: CoworkDraft = {
    ...selectCoworkDate(openSpace, "2026-12-03"),
    coffee: true,
  };
  let [pack, unlimited] = links(render({ draft: withCoffee }));
  expect(press(pack)).toEqual({
    pathname: "/passes/entry-pack",
    params: { tier: "open-space" },
  });
  expect(press(unlimited)).toEqual({
    pathname: "/passes/unlimited",
    params: { tier: "open-space", coffee: "1", startDate: "2026-12-03" },
  });

  // Reserved Desk with a workstation: coffee no longer applies.
  const desk = selectCoworkWorkstation(
    selectCoworkDate(
      selectCoworkTier(withCoffee, "reserved-desk"),
      "2026-12-05"
    ),
    Option.some("2x27-4k")
  );
  [pack, unlimited] = links(render({ draft: desk }));
  expect(press(pack)).toEqual({
    pathname: "/passes/entry-pack",
    params: { tier: "reserved-desk-workstation" },
  });
  expect(press(unlimited)).toEqual({
    pathname: "/passes/unlimited",
    params: {
      tier: "reserved-desk-workstation",
      monitorOption: "2x27-4k",
      startDate: "2026-12-05",
    },
  });

  // Clearing the workstation and the date drops their parameters.
  const cleared: CoworkDraft = {
    ...selectCoworkWorkstation(desk, Option.none()),
    date: Option.none(),
  };
  [pack, unlimited] = links(render({ draft: cleared }));
  expect(press(pack)).toEqual({
    pathname: "/passes/entry-pack",
    params: { tier: "reserved-desk" },
  });
  expect(press(unlimited)).toEqual({
    pathname: "/passes/unlimited",
    params: { tier: "reserved-desk" },
  });

  // Back to Open Space with coffee off.
  [, unlimited] = links(
    render({
      draft: { ...selectCoworkTier(cleared, "open-space"), coffee: false },
    })
  );
  expect(press(unlimited)).toEqual({
    pathname: "/passes/unlimited",
    params: { tier: "open-space" },
  });
});

test("the Unlimited card's expiry follows the draft's date, else today", () => {
  const expiries = (draft: CoworkDraft) =>
    findAll(render({ draft }), "Text")
      .map(textOf)
      .filter((label) => label.includes("2026") || label.includes("2027"));
  const undated = expiries(openSpace);
  const dated = expiries(selectCoworkDate(openSpace, "2027-01-10"));
  expect(undated).toHaveLength(1);
  expect(dated).toHaveLength(1);
  expect(undated[0]).toContain("Dec");
  expect(dated[0]).toContain("Feb");
});

test("at 200% text the stub widens and the ticket keeps every label", () => {
  const dimensions = spyOn(ReactNative, "useWindowDimensions").mockReturnValue({
    width: 360,
    height: 800,
    fontScale: 2,
    scale: 3,
  });
  try {
    const tree = render({});
    const texts = findAll(tree, "Text").filter(
      ({ props }) => props.numberOfLines !== undefined
    );
    expect(texts).toHaveLength(0);
    const stub = findAll(tree, "View").find(({ props }) =>
      [props.style]
        .flat(2)
        .some(
          (style) =>
            typeof style === "object" &&
            style !== null &&
            "minWidth" in style &&
            style.minWidth === 104
        )
    );
    expect(stub).toBeDefined();
    // The credential's photo area moves to the top of its row.
    const topAligned = findAll(tree, "View").filter(
      ({ props }) => flatStyle(props.style).alignItems === "flex-start"
    );
    expect(topAligned.length).toBeGreaterThan(0);
  } finally {
    dimensions.mockRestore();
  }
});

test("the Book chooser's Entry pack link still opens the pack purchase for its draft", () => {
  const tree = hostTree(
    <EntryPackOfferLink catalog={catalog} draft={openSpace} />,
    (node) => <AppLocaleProvider locale="en-US">{node}</AppLocaleProvider>
  );
  const link = findAll(tree, "Pressable").find(
    ({ props }) => props.role === "link"
  );
  expect(press(link)).toEqual({
    pathname: "/passes/entry-pack",
    params: { tier: "open-space" },
  });
});

test("Enter on a focused card follows it once, to the route a press opens", () => {
  const draft = selectCoworkDate(
    selectCoworkTier(openSpace, "reserved-desk"),
    "2026-12-03"
  );
  for (const link of links(render({ draft }))) {
    const pressed = press(link);
    push.mockClear();
    const onKeyDown = link.props.onKeyDown as (event: unknown) => void;
    onKeyDown({ nativeEvent: { key: "Tab" }, preventDefault: () => {} });
    expect(push).not.toHaveBeenCalled();
    let prevented = false;
    onKeyDown({
      nativeEvent: { key: "Enter" },
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0]).toEqual(pressed);
    expect(prevented).toBe(true);
  }
});
