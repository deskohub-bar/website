import { describe, expect, mock, test } from "bun:test";
import type { CustomerReservationFamily } from "@deskohub/workspace-customer-api";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";
import {
  elementTree,
  findAll,
  flatStyle,
  hostTree,
  textOf,
} from "../../ui/testing/element-tree";
import {
  czk,
  sampleOfferings,
  samplePrices,
} from "../testing/sample-booking-catalog";
import { SpaceCards, SpaceCardsSkeleton } from "./space-cards";
import { spaceCards } from "./space-chooser";

const catalog = sampleOfferings("en-US", "2026-11-10").offerings;

const render = (
  families: ReadonlyArray<CustomerReservationFamily>,
  onOpen = mock((_: CustomerReservationFamily) => undefined)
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
