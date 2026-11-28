import { describe, expect, test } from "bun:test";
import type {
  CustomerBookingOfferings,
  CustomerPassCatalog,
  CustomerUnlimitedStartDates,
} from "@deskohub/workspace-customer-api";
import { RegistryProvider } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ReactElement } from "react";
import type { PressableProps } from "react-native";
import { bookingOfferingsAtom } from "../../../booking/data/booking-queries";
import { m } from "../../../i18n/messages";
import { formatMoney } from "../../../i18n/money-format";
import {
  elementTree,
  find,
  findAll,
  hostTree,
  textOf,
} from "../../../ui/testing/element-tree";
import { ChooseCards } from "./choose-cards";
import { PassChoose, type PassChooseSelection } from "./pass-choose";

const czk = (amount: number) => ({
  currency: "CZK",
  exponent: 2,
  value: amount * 100,
});

const catalog: CustomerPassCatalog = {
  entryPacks: [
    {
      product: { kind: "entry-pack", tier: "open-space", size: 5 },
      price: czk(1200),
      validityMonths: 2,
    },
    {
      product: {
        kind: "entry-pack",
        tier: "reserved-desk-workstation",
        size: 10,
      },
      price: czk(3520),
      validityMonths: 3,
    },
  ],
  unlimited: [
    {
      product: { kind: "unlimited", tier: "open-space" },
      price: czk(3400),
      validityDays: 30,
    },
    {
      product: { kind: "unlimited", tier: "reserved-desk" },
      price: czk(5900),
      validityDays: 30,
    },
    {
      product: { kind: "unlimited", tier: "reserved-desk-workstation" },
      price: czk(8400),
      validityDays: 30,
    },
  ],
  unlimitedCoffeePrice: czk(680),
};

const dates: CustomerUnlimitedStartDates = {
  today: "2026-10-30",
  lastStartDate: "2026-11-03",
  starts: {
    "open-space": ["2026-10-30", "2026-10-31"],
    "reserved-desk": ["2026-10-31", "2026-11-02"],
    "reserved-desk-workstation": {
      "2x27-qhd": ["2026-10-30", "2026-11-01"],
      "2x32-qhd": [],
      "2x27-4k": ["2026-10-30", "2026-11-02"],
      "2x32-4k": [],
    },
  },
};

const bookingOfferings: CustomerBookingOfferings = {
  advertisedOn: dates.today,
  openingHours: "",
  offerings: [
    {
      family: "cowork",
      tier: "reserved-desk",
      name: "Reserved Desk",
      description: "",
      usage: "",
      price: czk(415),
      advertisedPrice: { price: czk(320), discount: czk(95) },
      bookableDates: { earliest: dates.today, latest: dates.lastStartDate },
      addOns: [
        {
          id: "workstation",
          name: "Workstation",
          price: czk(100),
          included: false,
        },
      ],
    },
  ],
};

type Props = Parameters<typeof PassChoose>[0];

const render = (overrides: Partial<Props> = {}) => {
  const patches: Partial<PassChooseSelection>[] = [];
  const props: Props = {
    kind: "unlimited",
    locale: "en-US",
    catalog,
    dates,
    selection: {
      tier: "open-space",
      size: 5,
      startDate: dates.today,
      coffee: false,
    },
    onChange: (patch) => patches.push(patch),
    ...overrides,
  };
  const tree = elementTree(PassChoose, props);
  const within = (node: ReactElement) => (
    <RegistryProvider
      initialValues={[
        [
          bookingOfferingsAtom(props.locale),
          AsyncResult.success(bookingOfferings),
        ],
      ]}
    >
      {node}
    </RegistryProvider>
  );
  return { tree, within, patches };
};

describe("PassChoose", () => {
  test("uses available pack sizes and the regular single-day price with workstation", () => {
    const { tree, within, patches } = render({
      kind: "entry-pack",
      locale: "cs-CZ",
      selection: { tier: "reserved-desk-workstation", size: 10, coffee: false },
    });
    const options = findAll(tree, ChooseCards);
    const [tierOptions] = options;
    expect(tierOptions?.props.options.map(({ value }) => value)).toEqual([
      "open-space",
      "reserved-desk-workstation",
    ]);
    tierOptions?.props.onSelect("open-space");
    expect(patches).toEqual([{ tier: "open-space", size: 5 }]);

    const text = findAll(hostTree(tree, within), "Text");
    expect(text.map((node) => node.props.children).flat(Infinity)).toContain(
      m.pass_choose_saving(
        { price: formatMoney(czk(163), "cs-CZ") },
        { locale: "cs-CZ" }
      )
    );
  });

  test("clears coffee and dates that the next desk tier cannot use", () => {
    const { tree, patches } = render({
      selection: {
        tier: "open-space",
        size: 5,
        coffee: true,
        startDate: dates.today,
      },
    });
    find(tree, ChooseCards)?.props.onSelect("reserved-desk");
    expect(patches).toEqual([
      {
        tier: "reserved-desk",
        coffee: false,
        startDate: undefined,
        monitorOption: undefined,
      },
    ]);
  });

  test("keeps the draft start date while availability is loading", () => {
    const { tree, patches } = render({ dates: undefined });
    find(tree, ChooseCards)?.props.onSelect("reserved-desk");
    expect(patches).toEqual([
      {
        tier: "reserved-desk",
        coffee: false,
        startDate: dates.today,
        monitorOption: undefined,
      },
    ]);
  });

  test("disables unavailable monitor setups and skips them with the keyboard", () => {
    const { tree, patches } = render({
      selection: {
        tier: "reserved-desk-workstation",
        size: 5,
        startDate: dates.today,
        monitorOption: "2x27-qhd",
        coffee: false,
      },
    });
    const host = hostTree(tree);
    const radios = findAll<PressableProps>(host, "Pressable").filter(
      ({ props }) => props.role === "radio"
    );
    const monitorRadios = radios.slice(3);
    expect(
      monitorRadios.map(({ props }) => [
        props["aria-checked"],
        props.disabled,
        props.tabIndex,
      ])
    ).toEqual([
      [true, false, 0],
      [false, true, -1],
      [false, false, -1],
      [false, true, -1],
    ]);

    const day = (label: string) =>
      findAll<PressableProps>(host, "Pressable").find(({ props }) =>
        props["aria-label"]?.startsWith(label)
      );
    expect(day("Saturday, October 31")?.props.disabled).toBe(true);

    const monitorChoice = monitorRadios[0]?.props;
    const key = {
      nativeEvent: { key: "ArrowRight" },
      preventDefault: () => undefined,
    };
    monitorChoice?.onKeyDown?.(
      key as Parameters<NonNullable<PressableProps["onKeyDown"]>>[0]
    );
    expect(patches).toEqual([{ monitorOption: "2x27-4k" }]);
  });

  test("choosing a valid start clears a monitor that cannot cover it", () => {
    const { tree, patches } = render({
      selection: {
        tier: "reserved-desk-workstation",
        size: 5,
        startDate: "2026-11-01",
        monitorOption: "2x27-qhd",
        coffee: false,
      },
    });
    const day = findAll<PressableProps>(hostTree(tree), "Pressable").find(
      ({ props }) => props["aria-label"]?.startsWith("Monday, November 2")
    );
    expect(day?.props.disabled).toBe(false);
    expect(day?.props["aria-selected"]).toBe(false);
    day?.props.onPress?.(
      {} as Parameters<NonNullable<PressableProps["onPress"]>>[0]
    );
    expect(patches).toEqual([
      { startDate: "2026-11-02", monitorOption: undefined },
    ]);
    const covered = findAll<PressableProps>(hostTree(tree), "Pressable").find(
      ({ props }) => props["aria-label"]?.startsWith("Friday, November 6")
    );
    expect(covered?.props.disabled).toBe(true);
    expect(covered?.props["aria-label"]).toContain(
      m.pass_choose_calendar_covered({}, { locale: "en-US" })
    );
  });

  test("shows loading while dates are pending and lets the calling screen show a failure", () => {
    const pending = hostTree(render({ dates: undefined }).tree);
    const failed = hostTree(
      render({ dates: undefined, datesFailed: true }).tree
    );
    const indicators = (tree: typeof pending) =>
      findAll(tree, "View").filter(({ props }) => props.role === "progressbar");
    expect(indicators(pending)).toHaveLength(1);
    expect(indicators(failed)).toHaveLength(0);
  });

  test("the Open Space coffee card is one switch containing the icon and price", () => {
    const { tree, patches } = render();
    const switches = findAll<PressableProps>(
      hostTree(tree),
      "Pressable"
    ).filter(({ props }) => props.role === "switch");
    expect(switches).toHaveLength(1);
    const [toggle] = switches;
    expect(toggle?.props["aria-checked"]).toBe(false);
    expect(findAll(toggle, "Svg")).toHaveLength(1);
    expect(findAll(toggle, "Text").map(textOf)).toContain(
      m.booking_addon_price(
        { price: formatMoney(catalog.unlimitedCoffeePrice, "en-US") },
        { locale: "en-US" }
      )
    );
    toggle?.props.onPress?.(
      {} as Parameters<NonNullable<PressableProps["onPress"]>>[0]
    );
    expect(patches).toEqual([{ coffee: true }]);
    const reserved = render({
      selection: { tier: "reserved-desk", size: 5, coffee: false },
    });
    expect(
      findAll<PressableProps>(hostTree(reserved.tree), "Pressable").some(
        ({ props }) => props.role === "switch"
      )
    ).toBe(false);
  });
});
