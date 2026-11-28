import { expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Result, Schema } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import {
  makeFakeSavedLocalePreference,
  syntheticSessionCookie,
} from "@/features/account/backend/saved-locale-preference.test-utils";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { PaymentProviders } from "@/features/checkout/backend/payment/payment-provider";
import { canonicalPromotionCodeSchema } from "@/features/discounts/contracts";
import { type Locale, m } from "@/features/i18n";
import { getLocale } from "@/features/i18n/paraglide/runtime.js";
import { type OrderId, orderIdSchema } from "@/features/order";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { currencyCZK } from "@/shared/money/currencies";
import { fixtureReservationAuthorId as accountId } from "@/shared/testing/workspace-fixtures.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { passPurchaseQuoteCodec } from "./pass-purchase-quote";

const requestHeaders = new AsyncLocalStorage<Headers>();
mock.module("next/headers", () => ({
  headers: async () => requestHeaders.getStore() ?? new Headers(),
  cookies: async () => ({
    get: (name: string) => {
      const item = requestHeaders
        .getStore()
        ?.get("cookie")
        ?.split("; ")
        .find((cookie) => cookie.startsWith(`${name}=`));
      return item ? { name, value: item.slice(name.length + 1) } : undefined;
    },
  }),
}));

const reader = makeFakeSavedLocalePreference();
mock.module("@/features/account/server/saved-locale-preference.server", () => ({
  savedLocalePreference: reader.savedLocalePreference,
}));

const buyerEmail = testEmailAddress("entry-pack-action-buyer");
Object.defineProperty(CurrentCustomerAccount, "Live", {
  value: Layer.mock(CurrentCustomerAccount, {
    requireActive: Effect.succeed({
      accountId,
      email: buyerEmail,
      deletionRequested: false,
      ...testSessionProfile,
    }),
  }),
});

const issuedOrders = new Map<OrderId, Locale>();
const paidOrders = new Set<OrderId>();
const entryPackOrders = await import("./backend/entry-pack-order");
const readOwnedLocale = mock((orderId: OrderId) =>
  Effect.succeed(issuedOrders.get(orderId))
);
mock.module("./backend/entry-pack-order", () => ({
  ...entryPackOrders,
  readOwnedPassPurchaseOrderLocale: readOwnedLocale,
  readOwnedPassPurchaseStatusPath: (orderId: OrderId) =>
    Effect.succeed(
      paidOrders.has(orderId)
        ? `/en-US/reservation/status/${orderId}`
        : undefined
    ),
  findOwnedPassPurchaseOrder: (orderId: OrderId) =>
    Effect.sync(() => {
      const locale = issuedOrders.get(orderId);
      return (
        locale && {
          order: {
            id: orderId,
            paymentState: paidOrders.has(orderId) ? "paid" : "not_started",
            activePaymentAttemptId: null,
          },
          purchase: { locale },
        }
      );
    }),
}));

mock.module("@/features/order/backend/order-kind", () => ({
  findOrderKind: (orderId: OrderId) =>
    Effect.succeed(issuedOrders.has(orderId) ? "pass-purchase" : undefined),
}));

const amount = currencyCZK(115_000);
const observedLocales = mock((_locale: Locale) => {});
const observeProviders = mock((_providers: readonly string[]) => {});
const purchase = await import("./backend/entry-pack-purchase");
mock.module("./backend/entry-pack-purchase", () => ({
  ...purchase,
  beginEntryPackPurchase: (
    input: Parameters<typeof purchase.beginEntryPackPurchase>[0]
  ) =>
    Effect.sync(() => {
      issuedOrders.set(input.orderId, input.locale);
      return {
        id: input.orderId,
        locale: input.locale,
        tier: input.product.tier,
        entryCount: input.product.size,
        validFrom: Temporal.PlainDate.from("2026-11-20"),
        validUntil: Temporal.PlainDate.from("2027-01-19"),
        quote: Schema.encodeSync(passPurchaseQuoteCodec)({
          product: input.product,
          discountableSubtotal: amount,
          discountedSubtotal: amount,
          totalDiscount: currencyCZK(0),
          discounts: [],
        }),
      };
    }),
  payForEntryPack: (input: Parameters<typeof purchase.payForEntryPack>[0]) =>
    Effect.gen(function* () {
      const providers = yield* PaymentProviders;
      yield* LatePaymentVerificationService;
      observeProviders(providers.activeProviders);
      observedLocales(getLocale());
      if (!issuedOrders.has(input.orderId)) {
        return yield* new purchase.EntryPackPurchaseError({
          reason: "unavailable",
        });
      }
      return { status: "pending", statusUrl: "/fixture/status" };
    }),
}));

const unlimited = await import("./backend/unlimited-pass-purchase");
const unlimitedFailures = new Map<OrderId, Error>();
const beginUnlimited = mock(
  (input: Parameters<typeof unlimited.beginUnlimitedPassPurchase>[0]) =>
    Effect.sync(() => {
      const failure = unlimitedFailures.get(input.orderId);
      assert(failure);
      return {
        outcome: Result.fail(failure),
        retiredPredecessorOrderIds: input.supersedeOrderIds?.slice(1) ?? [],
      };
    })
);
mock.module("./backend/unlimited-pass-purchase", () => ({
  ...unlimited,
  beginUnlimitedPassPurchase: beginUnlimited,
}));

const { beginEntryPackCheckout, beginUnlimitedCheckout, payEntryPackCheckout } =
  await import("./entry-pack-checkout-actions");
const { readPassCheckoutHandoff, sealPassCheckoutHandoff } = await import(
  "./backend/pass-checkout-handoff"
);

const withoutReferer = <A>(action: () => A) =>
  requestHeaders.run(
    new Headers({
      cookie: `${syntheticSessionCookie}; PARAGLIDE_LOCALE=cs-CZ`,
    }),
    action
  );

const sealHandoff = (value: Parameters<typeof sealPassCheckoutHandoff>[0]) =>
  Effect.runPromise(
    sealPassCheckoutHandoff(value).pipe(Effect.provide(SealedStateKeys.Default))
  );

const openHandoff = (token: string) =>
  Effect.runPromise(
    readPassCheckoutHandoff(token).pipe(
      Effect.provide(
        Layer.merge(SealedStateKeys.Default, CurrentCustomerAccount.Live)
      )
    )
  );

test("Details issues an order and in-place Pay uses its verified locale without Referer", async () => {
  const orderId = crypto.randomUUID();
  reader.fake.savedPreference = "en-US";
  expect(issuedOrders.size).toBe(0);

  const begin = await withoutReferer(() =>
    beginEntryPackCheckout({
      locale: "en-US",
      orderId,
      buyerEmail,
      product: { kind: "entry-pack", tier: "open-space", size: 5 },
    })
  );
  const ready = begin.data;
  expect(ready?.status).toBe("ready");
  if (ready?.status !== "ready")
    throw new Error("Details did not issue a Pay snapshot");

  reader.fake.savedPreference = "cs-CZ";
  const pay = {
    locale: "cs-CZ" as const,
    orderId,
    accepted: true,
    acceptedDocuments: ready.disclosure.documents,
    displayedPriceFingerprint: ready.price.fingerprint,
    billing: { purpose: "personal", invoice: "none" } as const,
  };
  const owned = await withoutReferer(() => payEntryPackCheckout(pay));
  expect(owned.data).toEqual({
    status: "pending",
    statusUrl: "/fixture/status",
  });
  expect(observedLocales).toHaveBeenLastCalledWith("en-US");
  expect(observeProviders).toHaveBeenCalledWith(["nexi"]);

  const foreign = await withoutReferer(() =>
    payEntryPackCheckout({
      ...pay,
      orderId: crypto.randomUUID(),
      locale: "en-US",
    })
  );
  expect(foreign.data).toEqual({
    status: "purchase_error",
    reason: "unavailable",
  });
  expect(observedLocales).toHaveBeenLastCalledWith("cs-CZ");

  const lookups = readOwnedLocale.mock.calls.length;
  const malformed = await withoutReferer(() =>
    payEntryPackCheckout({ ...pay, orderId: "malformed" })
  );
  expect(malformed.validationErrors?.fieldErrors.orderId).toBeDefined();
  expect(readOwnedLocale).toHaveBeenCalledTimes(lookups);
});

test("Continue from an open Entry Pack handoff returns to status after payment", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const product = {
    kind: "entry-pack",
    tier: "reserved-desk",
    size: 5,
  } as const;
  const handoffToken = await sealHandoff({
    buyerAccountId: accountId,
    orderId,
    product,
  });
  paidOrders.add(orderId);
  const result = await withoutReferer(() =>
    beginEntryPackCheckout({
      orderId,
      locale: "en-US",
      buyerEmail,
      product,
      handoffToken,
    })
  );
  expect(result.data).toEqual({
    status: "status",
    statusPath: `/en-US/reservation/status/${orderId}`,
  });
});

test("Unlimited Continue applies the protected predecessor and referral from the handoff", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const supersedeOrderId = orderIdSchema.make(crypto.randomUUID());
  const referralCode = canonicalPromotionCodeSchema.make("REFERRAL");
  const holderEmail = testEmailAddress("unlimited-handoff-recipient");
  const selection = {
    tier: "reserved-desk",
    startDate: plainDateStringSchema.make("2026-12-05"),
  } as const;
  const handoffToken = await sealHandoff({
    buyerAccountId: accountId,
    orderId,
    product: { kind: "unlimited", selection },
    holderEmail,
    predecessorOrderIds: [supersedeOrderId],
    referralCode,
  });
  unlimitedFailures.set(
    orderId,
    new purchase.EntryPackPurchaseError({ reason: "holds-unavailable" })
  );
  await withoutReferer(() =>
    beginUnlimitedCheckout({
      locale: "en-US",
      orderId,
      buyerEmail,
      holderEmail,
      selection,
      recipientName: "Fixture Recipient",
      handoffToken,
    })
  );
  expect(beginUnlimited).toHaveBeenLastCalledWith(
    expect.objectContaining({
      orderId,
      holderEmail,
      supersedeOrderIds: [supersedeOrderId],
      referralCode,
    })
  );
});

test("Unlimited reissues gift context before replacement and after capacity rejection", async () => {
  const priorHoldId = orderIdSchema.make(crypto.randomUUID());
  const originalOrderId = orderIdSchema.make(crypto.randomUUID());
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const referralCode = canonicalPromotionCodeSchema.make("REFERRAL");
  const holderEmail = testEmailAddress("replacement-gift-recipient");
  const selection = {
    tier: "reserved-desk",
    startDate: plainDateStringSchema.make("2026-12-05"),
  } as const;
  const handoffToken = await sealHandoff({
    buyerAccountId: accountId,
    orderId: originalOrderId,
    product: { kind: "unlimited", selection },
    holderEmail: testEmailAddress("original-gift-recipient"),
    predecessorOrderIds: [priorHoldId],
    referralCode,
  });
  const input = {
    locale: "en-US" as const,
    orderId,
    buyerEmail,
    holderEmail,
    selection,
    recipientName: "Fixture Replacement",
  };
  const beginCalls = beginUnlimited.mock.calls.length;
  const prepare = await withoutReferer(() =>
    beginUnlimitedCheckout({ ...input, handoffToken })
  );
  expect(prepare.data?.status).toBe("handoff_updated");
  expect(beginUnlimited.mock.calls).toHaveLength(beginCalls);
  if (prepare.data?.status !== "handoff_updated")
    throw new Error("Expected replacement handoff");
  const replacement = prepare.data.handoff;
  expect(await openHandoff(replacement.token)).toMatchObject({
    orderId,
    holderEmail,
    referralCode,
    predecessorOrderIds: [priorHoldId, originalOrderId],
  });
  unlimitedFailures.set(
    orderId,
    Object.assign(new Error("Synthetic capacity failure"), {
      _tag: "UnlimitedPassCapacityUnavailable",
      blockingDates: [],
    })
  );
  const submit = await withoutReferer(() =>
    beginUnlimitedCheckout({ ...input, handoffToken: replacement.token })
  );
  expect(beginUnlimited).toHaveBeenLastCalledWith(
    expect.objectContaining({
      orderId,
      holderEmail,
      referralCode,
      supersedeOrderIds: [priorHoldId, originalOrderId],
    })
  );
  expect(submit.data?.status).toBe("capacity_unavailable");
  if (submit.data?.status !== "capacity_unavailable" || !submit.data.handoff) {
    throw new Error("Expected a retry handoff");
  }
  const retry = submit.data.handoff;
  expect(retry.orderId).not.toBe(orderId);
  expect(await openHandoff(retry.token)).toMatchObject({
    orderId: retry.orderId,
    holderEmail,
    referralCode,
    predecessorOrderIds: [priorHoldId],
  });
});

test("a prepared recipient edit returns the original status when payment starts before submission", async () => {
  const originalOrderId = orderIdSchema.make(crypto.randomUUID());
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const holderEmail = testEmailAddress("unlimited-race-recipient");
  const selection = {
    tier: "reserved-desk",
    startDate: plainDateStringSchema.make("2026-12-05"),
  } as const;
  const token = await sealHandoff({
    buyerAccountId: accountId,
    orderId: originalOrderId,
    product: { kind: "unlimited", selection },
  });
  const input = {
    orderId,
    buyerEmail,
    holderEmail,
    locale: "en-US" as const,
    selection,
    recipientName: "Fixture Recipient",
  };
  const prepared = await withoutReferer(() =>
    beginUnlimitedCheckout({ ...input, handoffToken: token })
  );
  if (prepared.data?.status !== "handoff_updated")
    throw new Error("Expected prepared replacement");
  const handoffToken = prepared.data.handoff.token;
  paidOrders.add(originalOrderId);
  unlimitedFailures.set(
    orderId,
    new purchase.EntryPackPurchaseError({
      reason: "payment-in-progress",
      orderId: originalOrderId,
    })
  );
  const result = await withoutReferer(() =>
    beginUnlimitedCheckout({
      ...input,
      handoffToken,
    })
  );
  expect(result.data).toMatchObject({
    status: "status",
    statusPath: `/en-US/reservation/status/${originalOrderId}`,
  });
  expect(beginUnlimited).toHaveBeenLastCalledWith(
    expect.objectContaining({
      orderId,
      continueFromHandoff: true,
      supersedeOrderIds: [originalOrderId],
    })
  );
});

test("an open Unlimited Continue returns to the buyer's status after payment starts", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  paidOrders.add(orderId);
  unlimitedFailures.set(
    orderId,
    new purchase.EntryPackPurchaseError({ reason: "payment-in-progress" })
  );
  const result = await withoutReferer(() =>
    beginUnlimitedCheckout({
      orderId,
      buyerEmail,
      locale: "en-US",
      selection: {
        tier: "reserved-desk",
        startDate: plainDateStringSchema.make("2026-12-05"),
      },
    })
  );
  expect(result.data).toMatchObject({
    status: "status",
    statusPath: `/en-US/reservation/status/${orderId}`,
  });
});

test.each([undefined, "", " \t "])(
  "Unlimited Continue rejects a missing or blank gift name before beginning checkout (%p)",
  async (recipientName) => {
    const calls = beginUnlimited.mock.calls.length;
    const result = await withoutReferer(() =>
      beginUnlimitedCheckout({
        locale: "en-US",
        orderId: orderIdSchema.make(crypto.randomUUID()),
        buyerEmail,
        holderEmail: testEmailAddress("unlimited-action-holder"),
        selection: { tier: "reserved-desk", startDate: "2026-11-20" },
        ...(recipientName !== undefined && { recipientName }),
      })
    );
    expect(result.validationErrors?.fieldErrors.recipientName).toEqual([
      m.unlimitedPassRecipientNameRequired({}, { locale: "cs-CZ" }),
    ]);
    expect(beginUnlimited).toHaveBeenCalledTimes(calls);
  }
);

test("Unlimited Continue normalizes a gift name without returning it", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const recipientName = "李";
  unlimitedFailures.set(
    orderId,
    new purchase.EntryPackPurchaseError({ reason: "holds-unavailable" })
  );
  const result = await withoutReferer(() =>
    beginUnlimitedCheckout({
      locale: "en-US",
      orderId,
      buyerEmail,
      holderEmail: testEmailAddress("unlimited-action-holder"),
      selection: { tier: "reserved-desk", startDate: "2026-11-20" },
      recipientName: `  ${recipientName}  `,
    })
  );
  expect(beginUnlimited.mock.calls.at(-1)?.[0].recipientName).toBe(
    recipientName
  );
  expect(result.data).toMatchObject({
    status: "purchase_error",
    reason: "holds-unavailable",
  });
  expect(JSON.stringify(result)).not.toContain(recipientName);
});

test("Unlimited Continue passes the validated renewal source to purchase admission", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const renewsPassId = orderIdSchema.make(crypto.randomUUID());
  unlimitedFailures.set(
    orderId,
    new purchase.EntryPackPurchaseError({ reason: "holds-unavailable" })
  );
  const input = {
    locale: "en-US",
    orderId,
    buyerEmail,
    renewsPassId,
    selection: { tier: "reserved-desk", startDate: "2026-11-20" },
  } as const;
  await withoutReferer(() => beginUnlimitedCheckout(input));
  expect(beginUnlimited.mock.calls.at(-1)?.[0]).toMatchObject({ renewsPassId });
  const calls = beginUnlimited.mock.calls.length;
  const response = await withoutReferer(() =>
    beginUnlimitedCheckout({ ...input, renewsPassId: "invalid" })
  );
  expect(response.validationErrors?.fieldErrors.renewsPassId).toBeDefined();
  expect(beginUnlimited).toHaveBeenCalledTimes(calls);
});

test.each([
  {
    error: new purchase.EntryPackPurchaseError({ reason: "holds-unavailable" }),
    response: { status: "purchase_error", reason: "holds-unavailable" },
  },
  {
    error: new Error("Synthetic late Continue failure"),
    response: { status: "purchase_error", reason: "unavailable" },
  },
  {
    error: Object.assign(new Error("Synthetic cutoff void"), {
      _tag: "UnlimitedPassDraftVoided",
      blockingDates: ["2026-11-20"],
    }),
    response: { status: "draft_voided", blockingDates: ["2026-11-20"] },
  },
])(
  "Unlimited Continue returns durable predecessor acknowledgements for $error.message",
  async ({ error, response }) => {
    const orderId = orderIdSchema.make(crypto.randomUUID());
    const predecessorOrderIds = Array.from({ length: 8 }, () =>
      orderIdSchema.make(crypto.randomUUID())
    );
    unlimitedFailures.set(orderId, error);
    const result = await withoutReferer(() =>
      beginUnlimitedCheckout({
        locale: "en-US",
        orderId,
        buyerEmail,
        selection: { tier: "reserved-desk", startDate: "2026-11-20" },
        supersedeOrderIds: predecessorOrderIds,
      })
    );
    expect(result.data).toEqual({
      ...response,
      retiredPredecessorOrderIds: predecessorOrderIds.slice(1),
    });
  }
);
