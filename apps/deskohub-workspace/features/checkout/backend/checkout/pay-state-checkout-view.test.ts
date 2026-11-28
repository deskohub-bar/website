import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Option, Schema } from "effect";
import { checkoutSessionIdSchema } from "@/features/checkout/checkout-identifiers";
import { buildCoworkReservationQuote } from "@/features/checkout/checkout-quote.test-utils";
import type { CheckoutSummaryChangedKeys } from "@/features/checkout/checkout-summary";
import {
  canonicalPromotionCodeSchema,
  discountIdSchema,
} from "@/features/discounts/contracts";
import { normalizedCoworkReservationOrderSchema } from "@/features/reservation/cowork-reservation";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { TestSealedStateKeys } from "@/shared/testing/sealed-state-keys.test-utils";
import { instantStringSchema } from "@/shared/utils/temporal";
import { makeOfficePayRouteFixture } from "./office-pay-route.test-utils";
import { buildSignedPayState, PayState } from "./pay-state";
import {
  findCheckoutOfficeSelectionForVisitor,
  getPayStateCheckoutView,
} from "./pay-state-checkout-view";
import { getSubmittedCodeMetadata } from "./pay-state-contract";
import { buildPayStateCodeQuote } from "./pay-state-discount-code.test-utils";

const reservation = Schema.decodeSync(normalizedCoworkReservationOrderSchema)({
  kind: "cowork",
  entryTier: "basic",
  coffee: false,
  date: "2026-12-14",
  name: "Ada Lovelace",
  email: testEmailAddress("ada"),
  phone: "+420777000111",
});
const orderId = workspaceReservationIdSchema.make("reservation-id");

test("does not turn an unreadable office guest list into a seat-only hold", async () => {
  const { seal, services } = makeOfficePayRouteFixture({
    unavailablePeople: true,
  });
  const locale = "en-US";
  const payStateToken = await seal(locale);
  const result = await Effect.runPromise(
    findCheckoutOfficeSelectionForVisitor({ payStateToken, locale }).pipe(
      Effect.provide(services)
    )
  );
  expect(result).toEqual(Option.none());
});

const changedKeys: CheckoutSummaryChangedKeys = {
  sectionKeys: ["order"],
  itemKeys: ["product:cowork:basic"],
};
const issuedAt = Temporal.Instant.from("2026-07-01T10:00:00Z");

const holdExpiresAt = instantStringSchema.make("2026-07-01T10:08:00.000Z");
const submittedCode = canonicalPromotionCodeSchema.make("SPRING");
const submittedCodeDiscountId = discountIdSchema.make("spring-discount");

const buildState = (input?: {
  readonly changedKeys?: CheckoutSummaryChangedKeys;
  readonly withSubmittedCode?: true;
}) =>
  Effect.runPromise(
    buildSignedPayState(
      {
        locale: "en-US",
        reservation,
        quote: input?.withSubmittedCode
          ? buildPayStateCodeQuote(reservation, submittedCodeDiscountId)
          : buildCoworkReservationQuote(reservation),
        orderId,
        bookedAt: instantStringSchema.make("2026-07-01T09:58:00.000Z"),
        holdExpiresAt,
        checkoutSessionId: checkoutSessionIdSchema.make("checkout-session-id"),
        changedKeys: input?.changedKeys,
        ...getSubmittedCodeMetadata({
          submittedCode: input?.withSubmittedCode ? submittedCode : undefined,
          submittedCodeDiscountId,
        }),
      },
      { issuedAt }
    ).pipe(Effect.provide(TestSealedStateKeys))
  );

describe("getPayStateCheckoutView", () => {
  test("projects the signed order, summary, and token expiry", async () => {
    const state = await buildState();

    const view = getPayStateCheckoutView(state, issuedAt);

    expect(view.orderId).toBe(orderId);
    expect(view.expiresAt).toBe("2026-07-01T10:10:00.000Z");
    expect(view.summary).toEqual(PayState.summary(state));
    expect(view.changedKeys).toBeUndefined();
  });

  test("tells the hold deadline apart from the token expiry", async () => {
    const view = getPayStateCheckoutView(await buildState(), issuedAt);

    expect(view.holdExpiresAt).toBe(holdExpiresAt);
    expect(view.expiresAt).not.toBe(view.holdExpiresAt);
  });

  test("names the entered code the price includes, and none without one", async () => {
    const withCode = getPayStateCheckoutView(
      await buildState({ withSubmittedCode: true }),
      issuedAt
    );
    const withoutCode = getPayStateCheckoutView(await buildState(), issuedAt);

    expect(withCode.appliedDiscountCode).toEqual({
      code: submittedCode,
      discountId: submittedCodeDiscountId,
    });
    expect(withoutCode).not.toHaveProperty("appliedDiscountCode");
  });

  test("carries the changed keys of a price review", async () => {
    const state = await buildState({ changedKeys });

    expect(getPayStateCheckoutView(state, issuedAt).changedKeys).toEqual(
      changedKeys
    );
  });

  test("asks for early-performance consent from the start of the extended window", async () => {
    const state = await buildState();
    const requiredFrom = "2026-11-27T23:00:00.000Z";
    const requiredAt = Temporal.Instant.from(requiredFrom);
    const before = requiredAt.subtract({ milliseconds: 1 });

    const early = getPayStateCheckoutView(state, before);
    const due = getPayStateCheckoutView(state, requiredAt);

    expect(early.earlyPerformanceConsent).toEqual({
      required: false,
      requiredFrom,
    });
    expect(due.earlyPerformanceConsent).toEqual({
      required: true,
      requiredFrom,
    });
  });
});
