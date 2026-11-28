import { describe, expect, mock, test } from "bun:test";
import type {
  CustomerReservationFamily,
  CustomerTeamTableOfferings,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Pressable } from "react-native";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";
import {
  elementTree,
  findAll,
  flatStyle,
  hostTree,
  textOf,
} from "../../ui/testing/element-tree";
import type { BookingFamily } from "../selection/booking-selection";
import {
  czk,
  sampleOfferings,
  samplePrices,
} from "../testing/sample-booking-catalog";
import { SpaceCards, SpaceCardsSkeleton } from "./space-cards";
import { spaceCards } from "./space-chooser";

const catalog = sampleOfferings("en-US", "2026-11-10").offerings;

const teamTableCatalog = {
  advertisedOn: "2026-11-10",
  bookableDates: { earliest: "2026-11-10", latest: "2027-05-10" },
  offerings: [
    {
      product: { kind: "table", seats: 4, durationMinutes: 60 },
      name: "Team Table",
      price: czk(320),
      advertisedPrice: { price: czk(280), discount: czk(40) },
    },
    {
      product: { kind: "table", seats: 2, durationMinutes: 60 },
      name: "Team Table",
      price: czk(160),
      advertisedPrice: { price: czk(160), discount: czk(0) },
    },
  ],
} satisfies CustomerTeamTableOfferings;

describe("Team Table space", () => {
  test("the Hindi card renders a grammatical one-seat capacity label", () => {
    const offering = teamTableCatalog.offerings[0];
    if (offering === undefined) throw new Error("Missing sample Team Table");
    const tree = hostTree(
      elementTree(SpaceCards, {
        cards: spaceCards(catalog),
        locale: "hi-IN",
        onOpen: () => undefined,
        teamTable: AsyncResult.success({
          ...teamTableCatalog,
          offerings: [
            { ...offering, product: { ...offering.product, seats: 1 } },
          ],
        }),
      })
    );
    expect(findAll(tree, "Text").map(textOf)).toContain("सीटों की संख्या: 1");
  });
  const locale = "en-US";
  const renderChooser = (
    teamTable: AsyncResult.AsyncResult<CustomerTeamTableOfferings, unknown>,
    onOpen = mock((_: BookingFamily) => undefined)
  ) => {
    const tree = hostTree(
      elementTree(SpaceCards, {
        cards: spaceCards(catalog),
        locale,
        onOpen,
        teamTable,
      })
    );
    return { links: findAll(tree, "Pressable"), onOpen };
  };

  test("keeps the other links available during Team Table loading, release gating and errors", () => {
    const previous = AsyncResult.success(teamTableCatalog);
    for (const read of [
      AsyncResult.initial(),
      AsyncResult.success({ ...teamTableCatalog, offerings: [] }),
      AsyncResult.failWithPrevious("request failed", {
        previous: Option.some(previous),
      }),
    ]) {
      const { links } = renderChooser(read);
      expect(links).toHaveLength(3);
    }
  });

  test("opens Team Table from one link that shows distinct per-size base and hourly rates", () => {
    const { links, onOpen } = renderChooser(
      AsyncResult.success({
        ...teamTableCatalog,
        offerings: [
          ...teamTableCatalog.offerings,
          ...teamTableCatalog.offerings,
        ],
      })
    );
    expect(links).toHaveLength(4);
    const table = links.find(({ props }) =>
      String(props.accessibilityLabel).includes("Team Table")
    );
    if (table === undefined) throw new Error("No Team Table card");
    (table.props.onPress as () => void)();
    expect(onOpen).toHaveBeenCalledWith("table");
    const prices = findAll(table, "Text").map(textOf);
    for (const [base, hourly] of [
      [120, 40],
      [240, 80],
    ] as const) {
      expect(prices).toContain(
        m.booking_team_table_rate(
          {
            base: formatMoney(czk(base), locale),
            hourly: formatMoney(czk(hourly), locale),
          },
          { locale }
        )
      );
    }
  });
});

const render = (
  families: ReadonlyArray<CustomerReservationFamily>,
  onOpen = mock((_: BookingFamily) => undefined)
) => {
  const tree = hostTree(
    elementTree(SpaceCards, {
      cards: spaceCards(
        catalog.filter(({ family }) => families.includes(family))
      ),
      locale: "en-US",
      onOpen,
    })
  );
  const buttons = findAll(tree, "Pressable");
  // Each card's picture box: decorative, at the board's height.
  const pictures = findAll(tree, "View")
    .filter((view) => view.props["aria-hidden"] === true)
    .map((view) => flatStyle(view.props.style).height);
  return { buttons, pictures, onOpen };
};

describe("SpaceCards", () => {
  test("shows a link per space, each opening its space", () => {
    const { buttons, onOpen } = render(["office", "meeting-room", "cowork"]);

    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.props.role).toBe("link");
      expect(button.props.accessibilityLabel).toEqual(expect.any(String));
      (button.props.onPress as () => void)();
    }
    expect(onOpen.mock.calls.map(([family]) => family)).toEqual([
      "office",
      "meeting-room",
      "cowork",
    ]);
  });

  test("places the pass link immediately after the Cowork desk", () => {
    const tree = hostTree(
      elementTree(SpaceCards, {
        cards: spaceCards(catalog),
        locale: "en-US",
        onOpen: () => undefined,
        afterCowork: <Pressable accessibilityLabel="Entry packs" />,
      })
    );
    const buttons = findAll(tree, "Pressable");
    const link = buttons.findIndex(
      ({ props }) => props.accessibilityLabel === "Entry packs"
    );
    expect(link).toBeGreaterThan(0);
    expect(buttons[link - 1]?.props.accessibilityLabel).toContain(
      "Cowork desk"
    );
  });

  test("draws the office and meeting room as half cards over a full-width cowork card", () => {
    expect(render(["office", "meeting-room", "cowork"]).pictures).toEqual([
      104, 104, 148,
    ]);
  });

  test("draws a lone office or meeting room full width", () => {
    expect(render(["meeting-room", "cowork"]).pictures).toEqual([148, 148]);
    expect(render(["office", "cowork"]).pictures).toEqual([148, 148]);
  });
});

describe("SpaceCards prices", () => {
  test("each card shows its own name, from-price and billing unit", () => {
    const { buttons } = render(["office", "meeting-room", "cowork"]);
    const locale = "en-US";
    const perDay = m.booking_tier_price_per_day({}, { locale });
    const expected = [
      {
        name: catalog.find(({ family }) => family === "office")?.name,
        amount: samplePrices.officeDay + samplePrices.officeSeat,
        unit: perDay,
      },
      {
        name: catalog.find(({ family }) => family === "meeting-room")?.name,
        amount: samplePrices.meetingRoom["hour:1"],
        unit: m.booking_space_per_hour({}, { locale }),
      },
      {
        name: m.booking_family_cowork_title({}, { locale }),
        amount: samplePrices.openSpace,
        unit: perDay,
      },
    ];
    const cardTexts = buttons.map((button) =>
      findAll(button, "Text").map(textOf)
    );
    for (const { name, amount, unit } of expected) {
      const texts = cardTexts.find(
        (texts) => name !== undefined && texts.includes(name)
      );
      expect(texts).toContain(formatMoney(czk(amount), locale));
      expect(texts).toContain(unit);
    }
  });
});

describe("SpaceCardsSkeleton", () => {
  test("is one busy element with no interactive cards", () => {
    const tree = hostTree(
      elementTree(SpaceCardsSkeleton, { label: "Loading" })
    );
    const busy = findAll(tree, "View").filter(
      (view) => view.props["aria-busy"] === true
    );
    expect(busy).toHaveLength(1);
    expect(findAll(tree, "Pressable")).toHaveLength(0);
  });
});
