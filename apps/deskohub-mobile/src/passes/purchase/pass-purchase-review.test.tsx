import { expect, mock, test } from "bun:test";
import type { CustomerPassPurchase } from "@deskohub/workspace-customer-api";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import {
  elementTree,
  findAll,
  hostTree,
  textOf,
} from "../../ui/testing/element-tree";

mock.module("expo-router", () => expoRouterStandIn());
const { PassPurchaseReview } = await import("./pass-purchase-review");

const locale = "en-US";
const money = (value: number) => ({ value, currency: "CZK", exponent: 2 });
const startDate = "2026-12-01";
const createQuote = (
  selection: Extract<
    CustomerPassPurchase["product"],
    { kind: "unlimited" }
  >["selection"],
  price: CustomerPassPurchase["price"]
): CustomerPassPurchase => ({
  orderId: "01942447-f9dc-7000-8000-000000000001",
  product: { kind: "unlimited", selection },
  payPath: "/pay",
  statusPath: "/status",
  validFrom: startDate,
  lastUsableDate: "2026-12-30",
  price,
  disclosure: { documents: [] },
});

const price = {
  fingerprint: "a".repeat(64),
  subtotal: money(699000),
  total: money(699000),
  discounts: [],
};

const reviewText = (quote: CustomerPassPurchase) =>
  findAll(
    hostTree(
      elementTree(PassPurchaseReview, {
        quote,
        recipient: undefined,
        buyer: "Test Buyer",
        checked: false,
        busy: false,
        onToggle: () => undefined,
        onChange: () => undefined,
        onCode: () => undefined,
        locale,
      })
    ),
    "Text"
  ).map(textOf);

test("Membership Pay shows the purchase terms, monitor setup and daily door code", () => {
  const text = reviewText(
    createQuote(
      {
        tier: "reserved-desk-workstation",
        startDate,
        monitorOption: "2x32-4k",
      },
      price
    )
  );
  expect(text).toContain("Unlimited membership, 30 days");
  expect(text).toContain(
    "One payment covers 30 days. Membership doesn’t renew automatically. Eligible members can extend it themselves."
  );
  expect(text).toContain(m.pass_purchase_monitors({}, { locale }));
  expect(text).toContain("2× 32″ 4K");
  expect(text).toContain(m.pass_purchase_daily_code({}, { locale }));
});

test("Unlimited Pay itemizes Coffee using the quote's exact add-on amount", () => {
  const coffeePrice = money(99000);
  const text = reviewText(
    createQuote(
      { tier: "open-space", startDate, coffee: true },
      { ...price, subtotal: money(448000), total: money(448000), coffeePrice }
    )
  );
  expect(text).toContain(m.booking_checkout_line_coffee({}, { locale }));
  expect(text).toContain(formatMoney(coffeePrice, locale));
  expect(text).toContain(formatMoney(money(349000), locale));
  expect(
    text.filter((line) => line === formatMoney(money(448000), locale))
  ).toHaveLength(1);
});
