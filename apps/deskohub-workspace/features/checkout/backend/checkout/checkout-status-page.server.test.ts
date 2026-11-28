import "@/shared/testing/workspace-test-env";

import { expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { ICheckoutStatusService } from "./checkout-status.service";
import { loadCheckoutStatusPage } from "./checkout-status-page.server";

import {
  failedCheckoutStatusRead,
  fulfilledCheckoutStatus,
  statusPageAuthorizationFixture,
} from "./testing/checkout-status-fixture";

const input = {
  accessCookie: undefined,
  locale: "en-US",
  orderId: fulfilledCheckoutStatus.orderId,
  requestHeaders: new Headers(),
  returnOutcome: "success",
} as const;
test("falls back to authoritative local status after a page refresh read fails", async () => {
  const refreshStatus = mock<ICheckoutStatusService["refreshStatus"]>(() =>
    failedCheckoutStatusRead("refresh read failed")
  );
  const getStatus = mock(() => Effect.succeed(fulfilledCheckoutStatus));
  const isAuthorized = mock(() => Effect.succeed(true));

  const result = await Effect.runPromise(
    loadCheckoutStatusPage(
      { getStatus, refreshStatus },
      statusPageAuthorizationFixture(isAuthorized),
      input
    )
  );

  expect(result).toBe(fulfilledCheckoutStatus);
  expect(refreshStatus).toHaveBeenCalledTimes(1);
  expect(getStatus).toHaveBeenCalledTimes(1);
  expect(getStatus).toHaveBeenCalledWith({
    orderId: input.orderId,
    returnOutcome: input.returnOutcome,
  });
  expect(isAuthorized).toHaveBeenCalledWith({
    accessCookie: undefined,
    locale: input.locale,
    orderId: input.orderId,
    permission: "view-status",
  });
});

test("does not read checkout status when reservation access is unauthorized", async () => {
  const refreshStatus = mock<ICheckoutStatusService["refreshStatus"]>(() =>
    failedCheckoutStatusRead("must not refresh")
  );
  const getStatus = mock<ICheckoutStatusService["getStatus"]>(() =>
    failedCheckoutStatusRead("must not read")
  );
  const isAuthorized = mock(() => Effect.succeed(false));

  const result = await Effect.runPromise(
    loadCheckoutStatusPage(
      { getStatus, refreshStatus },
      statusPageAuthorizationFixture(isAuthorized),
      input
    )
  );

  expect(result).toEqual({
    orderId: input.orderId,
    returnOutcome: input.returnOutcome,
    status: "not_found",
  });
  expect(isAuthorized).toHaveBeenCalledTimes(1);
  expect(refreshStatus).not.toHaveBeenCalled();
  expect(getStatus).not.toHaveBeenCalled();
});

test("attributes a payment the page refresh finalizes to the page request's agent", async () => {
  const { CheckoutAnalytics } = await import(
    "@/features/checkout/backend/analytics/checkout-analytics.service"
  );
  const { recordCheckoutAnalytics } = await import(
    "@/features/checkout/backend/analytics/checkout-analytics.service.mock"
  );
  const analytics = recordCheckoutAnalytics();
  const refreshStatus = mock(() =>
    Effect.flatMap(CheckoutAnalytics, (checkoutAnalytics) =>
      checkoutAnalytics.paymentCompleted({
        attempt: {
          id: paymentAttemptIdSchema.make(
            "019edbd2-82f7-7cc0-8536-f2b3874d62d5"
          ),
          workspaceReservationId: input.orderId,
          provider: "nexi",
          amount: { value: 35_000, exponent: 2, currency: "CZK" },
        },
        timestamp: Temporal.Instant.from("2026-06-17T12:00:00.000Z"),
      })
    ).pipe(Effect.provide(analytics.layer), Effect.as(fulfilledCheckoutStatus))
  );

  await Effect.runPromise(
    loadCheckoutStatusPage(
      {
        getStatus: mock(() => Effect.succeed(fulfilledCheckoutStatus)),
        refreshStatus,
      },
      statusPageAuthorizationFixture(),
      {
        ...input,
        requestHeaders: new Headers({
          "user-agent":
            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
        }),
      }
    )
  );

  expect(analytics.messages).toHaveLength(1);
  expect(analytics.messages[0]?.properties).toMatchObject({
    agent_category: "ai_user_agent",
    agent_name: "chatgpt",
  });
});
