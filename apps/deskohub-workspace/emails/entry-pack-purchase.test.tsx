import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect } from "effect";
import { type Locale, locales, m } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import {
  getEntryPackPrice,
  getEntryPackValidity,
  getUnlimitedPassPrice,
} from "@/features/passes/pass-offer";
import { getUnlimitedPassEndDate } from "@/features/passes/unlimited-pass";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";
import { currencyCZK } from "@/shared/money/currencies";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { EntryPackGiftInvitationEmail } from "./entry-pack-gift-invitation";
import { EntryPackPurchaseEmail } from "./entry-pack-purchase";

const orderId = orderIdSchema.make("019ac0e6-f461-77de-9492-26af32cc74a3");
const paidAt = Temporal.Instant.from("2026-11-18T09:30:00Z");

const renderEntryPackEmail = (locale: Locale, earlyStartRequested: boolean) => {
  const product = { kind: "entry-pack", tier: "open-space", size: 10 } as const;
  const statusUrl = `https://example.com/${locale}/reservation/status/${orderId}`;
  const termsUrl = `https://example.com/${locale}/terms-and-conditions`;
  return Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackPurchaseEmail
        orderId={orderId}
        paidAt={paidAt}
        tier={product.tier}
        entryCount={product.size}
        {...getEntryPackValidity(paidAt, product.size)}
        locale={locale}
        quote={{
          product,
          discountableSubtotal: getEntryPackPrice(product),
          discountedSubtotal: getEntryPackPrice(product),
          totalDiscount: currencyCZK(0),
          discounts: [],
        }}
        holderEmail={null}
        invoiceRequested
        earlyStartRequested={earlyStartRequested}
        statusUrl={statusUrl}
        termsUrl={termsUrl}
      />
    )
  ).then((rendered) => ({ ...rendered, statusUrl, termsUrl }));
};

const renderUnlimitedPassEmail = (
  locale: Locale,
  earlyStartRequested: boolean
) => {
  const product = { kind: "unlimited", tier: "reserved-desk" } as const;
  const validFrom = plainDateStringSchema.make("2026-11-20");
  const validUntil = getUnlimitedPassEndDate(validFrom);
  const statusUrl = `https://example.com/${locale}/reservation/status/${orderId}`;
  const accessUrl = `https://example.com/${locale}/reservation/access/${orderId}`;
  const termsUrl = `https://example.com/${locale}/terms-and-conditions`;
  return Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackPurchaseEmail
        orderId={orderId}
        paidAt={paidAt}
        tier={product.tier}
        entryCount={null}
        validFrom={validFrom}
        validUntil={validUntil}
        locale={locale}
        quote={{
          product,
          discountableSubtotal: getUnlimitedPassPrice(product),
          discountedSubtotal: getUnlimitedPassPrice(product),
          totalDiscount: currencyCZK(0),
          discounts: [],
        }}
        holderEmail={null}
        invoiceRequested
        earlyStartRequested={earlyStartRequested}
        statusUrl={statusUrl}
        accessUrl={accessUrl}
        termsUrl={termsUrl}
      />
    )
  ).then((rendered) => ({ ...rendered, statusUrl, accessUrl, termsUrl }));
};

describe("EntryPackPurchaseEmail", () => {
  test.each([
    {
      locale: "en-US" as const,
      expectedCta: "Open your pass",
      expectedAmount: "2,190",
    },
    {
      locale: "cs-CZ" as const,
      expectedCta: "Otevřít balíček",
      expectedAmount: "2\u00a0190",
    },
  ])(
    "renders Entry pack receipt in $locale with pack CTA and conditional early-start notice",
    async ({ locale, expectedCta, expectedAmount }) => {
      const [withEarlyStart, withoutEarlyStart] = await Promise.all([
        renderEntryPackEmail(locale, true),
        renderEntryPackEmail(locale, false),
      ]);
      const packEarlyStart = m.passEmailEarlyStart({}, { locale });
      const unlimitedEarlyStart = m.unlimitedPassEmailEarlyStart(
        {},
        { locale }
      );
      const refundTerms = m.passEmailRefundTerms({}, { locale });

      expect(withEarlyStart.html).toContain(
        `href="${withEarlyStart.statusUrl}"`
      );
      expect(withEarlyStart.html).toContain(
        `href="${withEarlyStart.termsUrl}"`
      );
      expect(withEarlyStart.html).not.toContain("/reservation/access/");
      expect(withEarlyStart.html).toContain(expectedCta);
      expect(withEarlyStart.text).toContain(orderId);
      expect(withEarlyStart.text).toContain(expectedAmount);
      expect(withEarlyStart.text).toContain(packEarlyStart);
      expect(withEarlyStart.text).not.toContain(unlimitedEarlyStart);
      expect(withEarlyStart.text).toContain(refundTerms);

      expect(withoutEarlyStart.html).toContain(expectedCta);
      expect(withoutEarlyStart.text).not.toContain(packEarlyStart);
      expect(withoutEarlyStart.text).not.toContain(unlimitedEarlyStart);
      expect(withoutEarlyStart.text).toContain(refundTerms);
    }
  );

  test.each([
    {
      locale: "en-US" as const,
      expectedCta: "Open membership",
      forbiddenCta: "Open your pass",
      expectedAmount: "5,990",
    },
    {
      locale: "cs-CZ" as const,
      expectedCta: "Otevřít členství",
      forbiddenCta: "Otevřít balíček",
      expectedAmount: "5\u00a0990",
    },
  ])(
    "renders the Unlimited membership receipt in $locale with the membership CTA and conditional early-start notice",
    async ({ locale, expectedCta, forbiddenCta, expectedAmount }) => {
      const [withEarlyStart, withoutEarlyStart] = await Promise.all([
        renderUnlimitedPassEmail(locale, true),
        renderUnlimitedPassEmail(locale, false),
      ]);
      const packEarlyStart = m.passEmailEarlyStart({}, { locale });
      const unlimitedEarlyStart = m.unlimitedPassEmailEarlyStart(
        {},
        { locale }
      );
      const refundTerms = m.passEmailRefundTerms({}, { locale });

      expect(withEarlyStart.html).toContain(
        `href="${withEarlyStart.statusUrl}"`
      );
      expect(withEarlyStart.html).toContain(
        `href="${withEarlyStart.accessUrl}"`
      );
      expect(withEarlyStart.html).toContain(
        `href="${withEarlyStart.termsUrl}"`
      );
      expect(withEarlyStart.html).toContain(expectedCta);
      expect(withEarlyStart.html).not.toContain(forbiddenCta);
      expect(withEarlyStart.text).toContain(orderId);
      expect(withEarlyStart.text).toContain(expectedAmount);
      expect(withEarlyStart.text).toContain(unlimitedEarlyStart);
      expect(withEarlyStart.text).not.toContain(packEarlyStart);
      expect(withEarlyStart.text).toContain(refundTerms);

      expect(withoutEarlyStart.html).toContain(expectedCta);
      expect(withoutEarlyStart.html).not.toContain(forbiddenCta);
      expect(withoutEarlyStart.text).not.toContain(unlimitedEarlyStart);
      expect(withoutEarlyStart.text).not.toContain(packEarlyStart);
      expect(withoutEarlyStart.text).toContain(refundTerms);
    }
  );

  test.each(locales)(
    "renders the localized Unlimited membership CTA and early-start notice in %s",
    async (locale) => {
      const rendered = await renderUnlimitedPassEmail(locale, true);
      const cta = m.unlimitedPassEmailOpen({}, { locale });
      const earlyStart = m.unlimitedPassEmailEarlyStart({}, { locale });
      const englishCta = m.unlimitedPassEmailOpen({}, { locale: "en-US" });
      const englishEarlyStart = m.unlimitedPassEmailEarlyStart(
        {},
        { locale: "en-US" }
      );

      expect(cta).not.toBe("");
      expect(earlyStart).not.toBe("");
      if (locale !== "en-US") {
        expect(cta).not.toBe(englishCta);
        expect(earlyStart).not.toBe(englishEarlyStart);
      }
      expect(rendered.html).toContain(cta);
      expect(rendered.text).toContain(earlyStart);
    }
  );
});

test("uses membership copy for the gift purchase and invitation", async () => {
  const orderId = orderIdSchema.make("019ac0e6-f461-77de-9492-26af32cc74a3");
  const product = { kind: "unlimited", tier: "open-space" } as const;
  const price = getUnlimitedPassPrice(product);
  const validFrom = plainDateStringSchema.make("2026-11-18");
  const gift = {
    entryCount: null,
    holderEmail: testEmailAddress("recipient"),
    locale: "en-US",
    tier: product.tier,
    validUntil: getUnlimitedPassEndDate(validFrom),
  } as const;

  const purchase = await Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackPurchaseEmail
        {...gift}
        gift
        invitationSent
        invoiceRequested={false}
        earlyStartRequested={false}
        orderId={orderId}
        paidAt={Temporal.Instant.from("2026-11-18T09:30:00Z")}
        quote={{
          product,
          discountableSubtotal: price,
          discountedSubtotal: price,
          totalDiscount: currencyCZK(0),
          discounts: [],
        }}
        statusUrl={`https://example.com/en-US/reservation/status/${orderId}`}
        termsUrl="https://example.com/en-US/terms-and-conditions"
        validFrom={validFrom}
      />
    )
  );
  const invitation = await Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackGiftInvitationEmail
        {...gift}
        buyerName={null}
        claimUrl="https://example.com/en-US/account/passes"
      />
    )
  );

  expect(purchase.text).toContain("YOUR UNLIMITED MEMBERSHIP IS PAID");
  expect(purchase.text).toContain("Open membership");
  expect(purchase.text).not.toContain("Entry pack");
  expect(invitation.text).toContain("YOU RECEIVED AN UNLIMITED MEMBERSHIP");
  expect(invitation.text).toContain("Claim membership");
  expect(invitation.text).toContain("Valid through");
  expect(invitation.text).not.toContain("Entry pack");
  expect(invitation.text).not.toContain("one day at a time");
});

test("renders the paid coffee price for a pass bought before catalog repricing", async () => {
  const product = { kind: "unlimited", tier: "open-space" } as const;
  const { text } = await Effect.runPromise(
    renderWorkspaceEmail(
      <EntryPackPurchaseEmail
        orderId={orderIdSchema.make("019ac0e6-f461-77de-9492-26af32cc74a3")}
        paidAt={Temporal.Instant.from("2026-11-18T09:30:00Z")}
        tier={product.tier}
        entryCount={null}
        validFrom={plainDateStringSchema.make("2026-11-18")}
        validUntil={plainDateStringSchema.make("2026-12-18")}
        locale="en-US"
        quote={{
          product,
          discountableSubtotal: currencyCZK(350_000),
          discountedSubtotal: currencyCZK(350_000),
          totalDiscount: currencyCZK(0),
          discounts: [],
        }}
        holderEmail={null}
        invoiceRequested={false}
        earlyStartRequested={false}
        statusUrl="https://example.com/status"
        termsUrl="https://example.com/terms"
        coffeeAmountMinor={53_000}
      />
    )
  );

  expect(text).toMatch(/Coffee\s+CZK\s+530/u);
  expect(text).toMatch(/4,030/u);
});
