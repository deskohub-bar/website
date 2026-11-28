import { expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import {
  EmailConfigTag,
  EmailDeliveryIdSchema,
  type EmailMessage,
  EmailServiceTag,
} from "@deskohub/email";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Schema } from "effect";
import type { passPurchases } from "@/db/schema";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { m } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import { moneyCodec } from "@/shared/money/money";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { unlimitedAccessTokenQueryParam } from "../unlimited-access";
import {
  exchangeUnlimitedAccessToken,
  openUnlimitedAccessCookie,
} from "./unlimited-access-capability";

mock.module("server-only", () => ({}));
const { sendEntryPackPurchaseEmail } = await import(
  "./entry-pack-purchase-email"
);

test("emails the holder capability for a self-purchase and buyer status for a gift", async () => {
  const buyerAccountId = customerAccountIdSchema.make("synthetic-pass-buyer");
  const giftHolder = customerAccountIdSchema.make("synthetic-gift-holder");
  const id = orderIdSchema.make("01900000-0000-7000-8000-000000000014");
  const paidAt = Temporal.Instant.from("2030-03-30T12:00:00Z");
  const subtotal = Schema.decodeUnknownSync(moneyCodec)({
    value: 350000,
    exponent: 2,
    currency: "CZK",
  });
  const purchase: typeof passPurchases.$inferSelect = {
    id,
    product: "unlimited",
    tier: "open-space",
    buyerAccountId,
    holderAccountId: buyerAccountId,
    entryCount: null,
    unlimitedCoffee: false,
    unlimitedMonitorOption: null,
    holdsExpireAt: null,
    status: "active",
    validFrom: plainDateStringSchema.make("2030-03-31"),
    validUntil: plainDateStringSchema.make("2030-04-30"),
    accessEndsOn: null,
    buyerConfirmationDeliveredAt: null,
    quote: {
      product: { kind: "unlimited", tier: "open-space" },
      discountableSubtotal: subtotal,
      discounts: [],
      totalDiscount: { ...subtotal, value: 0 },
      discountedSubtotal: subtotal,
    },
    locale: "en-US",
    createdAt: paidAt,
    giftIssuedAt: null,
    giftClaimedAt: null,
  };

  const renderConfirmation = async (
    holderAccountId: typeof buyerAccountId,
    earlyStartRequested = true
  ) => {
    const gift = holderAccountId !== buyerAccountId;
    const messages: EmailMessage[] = [];
    await Effect.runPromise(
      sendEntryPackPurchaseEmail({
        purchase: { ...purchase, holderAccountId },
        price: { quote: purchase.quote },
        paidAt,
        paymentAttemptId: paymentAttemptIdSchema.make(
          "synthetic-payment-attempt"
        ),
        buyer: { email: testEmailAddress("pass-buyer") },
        holderEmail: gift ? testEmailAddress("pass-gift-holder") : null,
        gift,
        invitationSent: gift,
        invoiceRequested: false,
        earlyStartRequested,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(EmailConfigTag, {
              defaultFrom: { email: testEmailAddress("pass-sender") },
            }),
            Layer.mock(EmailServiceTag, {
              send: (message) =>
                Effect.sync(() => {
                  messages.push(message);
                  return {
                    id: EmailDeliveryIdSchema.make("synthetic-delivery"),
                    status: "sent" as const,
                    provider: "fixture",
                    timestamp: new Date(paidAt.epochMilliseconds),
                  };
                }),
            })
          )
        )
      )
    );
    expect(messages).toHaveLength(1);
    const [message] = messages;
    assert(message);
    return message;
  };

  const self = await renderConfirmation(buyerAccountId);
  const accessPath = `/en-US/reservation/access/${id}`;
  const hrefs = [...(self.html ?? "").matchAll(/href="([^"]+)"/g)].flatMap(
    (match) => (match[1] ? [match[1]] : [])
  );
  const href = hrefs.find((candidate) => candidate.includes(accessPath));
  assert(href);
  const url = new URL(href.replaceAll("&amp;", "&"));
  expect(url.pathname).toBe(accessPath);
  const token = url.searchParams.get(unlimitedAccessTokenQueryParam);
  assert(token);
  let now = paidAt.epochMilliseconds;
  const clock = { now: () => now };
  const cookie = await Effect.runPromise(
    exchangeUnlimitedAccessToken(
      { token, orderId: id, locale: purchase.locale },
      clock
    )
  );
  const allowsHolder = await Effect.runPromise(
    openUnlimitedAccessCookie(id, cookie.value, clock)
  );
  expect(allowsHolder(buyerAccountId)).toBe(true);
  expect(allowsHolder(giftHolder)).toBe(false);
  now += cookie.maxAge * 1000 - 1;
  expect(allowsHolder(buyerAccountId)).toBe(true);
  now += 1;
  expect(allowsHolder(buyerAccountId)).toBe(false);
  expect(self.sensitiveContent).toBe(true);

  const retry = await renderConfirmation(buyerAccountId);
  expect(retry.idempotencyKey).toBe(self.idempotencyKey);
  expect(retry.html?.includes(href)).toBe(true);
  const earlyStart = m.unlimitedPassEmailEarlyStart({}, { locale: "en-US" });
  expect(self.text).toContain(earlyStart);
  const withoutEarlyStart = await renderConfirmation(buyerAccountId, false);
  expect(withoutEarlyStart.text).not.toContain(earlyStart);
  const gift = await renderConfirmation(giftHolder);
  expect(gift.html).toContain(`/en-US/reservation/status/${id}`);
  expect(gift.html).not.toContain(accessPath);
});
