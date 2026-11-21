import "@/shared/testing/workspace-test-env";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { testEmailAddress } from "@deskohub/test-email";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { GET, POST } from "@/app/api/checkout/mock-payment/route";
import type { WorkspaceDatabase } from "@/db/database.service";
import { mockPaymentSessions } from "@/db/schema/mock-payment-sessions";
import { env } from "@/env";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  readMockHostedPaymentPage,
  submitMockHostedPaymentDecision,
} from "./mock-hosted-payment-route.server";
import {
  authorizeMockPaymentSession,
  makeMockPaymentProvider,
} from "./mock-payment-provider";
import type { PaymentSessionInput } from "./payment-provider";

const database = await createWorkspacePostgresSuiteDatabase(
  "mock_payment_provider"
);
const initialStage = {
  VERCEL_ENV: env.VERCEL_ENV,
  VERCEL_AUTOMATION_BYPASS_SECRET: env.VERCEL_AUTOMATION_BYPASS_SECRET,
};

const input: PaymentSessionInput = {
  amount: { value: 30_000, exponent: 2, currency: "CZK" },
  customer: {
    name: "Synthetic Customer",
    email: testEmailAddress("delivered+mock-provider-checkout"),
  },
  locale: "en",
  correlationId: "fixture-checkout",
  resultUrl: "https://checkout.example.test/en/checkout/pay/return/order",
  cancelUrl:
    "https://checkout.example.test/en/checkout/pay/return/order?outcome=cancelled",
  notificationUrl: "https://checkout.example.test/api/checkout/mock-webhook",
};

describe.skipIf(!database)("Mock payments on disposable Postgres", () => {
  if (!database) return;

  beforeEach(() => {
    Object.assign(env, {
      VERCEL_ENV: "preview",
      VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-test-protection",
    });
  });
  afterEach(() => Object.assign(env, initialStage));
  afterAll(() => database.close());

  const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceDatabase>) =>
    Effect.runPromise(effect.pipe(Effect.provide(database.layer)));

  const createSession = async () => {
    const adapter = await run(makeMockPaymentProvider);
    const session = await run(
      adapter
        .prepareSession(input)
        .pipe(Effect.flatMap((value) => value.create))
    );
    const reference = {
      providerOrderId: session.providerOrderId,
      correlationId: input.correlationId,
    };
    const verify = () =>
      run(
        adapter.verify({
          ...reference,
          amount: input.amount,
          securityToken: session.securityToken,
        })
      );
    const lookup = () => run(adapter.lookup(reference));
    const capability = {
      paymentId: session.providerOrderId,
      token: session.securityToken,
    };
    const read = () =>
      run(
        database.db
          .select()
          .from(mockPaymentSessions)
          .where(eq(mockPaymentSessions.paymentId, session.providerOrderId))
      );
    const request = (decision: string, token = session.securityToken) =>
      new Request(session.hostedPage, {
        method: "POST",
        body: new URLSearchParams({
          paymentId: session.providerOrderId,
          token,
          decision,
        }),
      });
    const submit = (decision: string, token?: string) =>
      run(submitMockHostedPaymentDecision(request(decision, token)));

    return {
      adapter,
      session,
      reference,
      verify,
      lookup,
      capability,
      read,
      request,
      submit,
    };
  };

  test("only authorizes a synthetic E2E checkout inside protected preview", async () => {
    const { adapter, session, request, capability, verify } =
      await createSession();
    await expect(
      run(
        adapter.prepareSession({
          ...input,
          customer: {
            name: "Synthetic Customer",
            email: testEmailAddress("unrecognized"),
          },
        })
      )
    ).rejects.toThrow("Test payments require a synthetic account in preview.");

    Object.assign(env, { VERCEL_AUTOMATION_BYPASS_SECRET: undefined });
    expect((await GET(new Request(session.hostedPage))).status).toBe(404);
    expect((await POST(request("approved"))).status).toBe(404);
    expect(await run(authorizeMockPaymentSession(capability))).toBe(false);
    await expect(run(adapter.prepareSession(input))).rejects.toThrow(
      "Test payments require a synthetic account in preview."
    );

    Object.assign(env, {
      VERCEL_ENV: "production",
      VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-test-protection",
    });
    expect((await GET(new Request(session.hostedPage))).status).toBe(404);
    expect((await POST(request("approved"))).status).toBe(404);

    Object.assign(env, { VERCEL_ENV: "preview" });
    expect(await verify()).toMatchObject({
      status: "pending",
      providerStatus: "pending",
    });
  });

  test("leaves the payment pending until a valid decision and persists only the authority hash", async () => {
    const {
      adapter,
      session,
      reference,
      capability,
      verify,
      lookup,
      read,
      submit,
    } = await createSession();
    const [stored] = await read();
    expect(
      stored?.capabilityHash ===
        createHash("sha256").update(session.securityToken).digest("hex")
    ).toBe(true);
    expect(stored).toMatchObject({ outcome: "pending", decidedAt: null });

    const wrongToken = "0".repeat(64);
    const untrustedUrl = new URL(session.hostedPage);
    untrustedUrl.searchParams.set("token", wrongToken);
    expect(
      (await run(readMockHostedPaymentPage(new Request(untrustedUrl)))).status
    ).toBe(404);
    expect((await submit("approved", wrongToken)).status).toBe(404);
    expect((await submit("invalid")).status).toBe(404);
    expect(
      await run(
        authorizeMockPaymentSession({ ...capability, token: wrongToken })
      )
    ).toBe(false);
    expect(await lookup()).toMatchObject({
      hasActivity: false,
      canRetry: false,
    });
    expect(await verify()).toMatchObject({ status: "pending", mismatches: [] });

    const page = await run(
      readMockHostedPaymentPage(new Request(session.hostedPage))
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html.includes("Approve test payment")).toBe(true);
    expect(html.includes("Decline test payment")).toBe(true);

    const response = await submit("approved");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(input.resultUrl);
    expect(await verify()).toMatchObject({
      status: "success",
      providerStatus: "succeeded",
    });
    expect(
      await run(
        adapter.verify({
          ...reference,
          amount: input.amount,
          securityToken: wrongToken,
        })
      )
    ).toMatchObject({ status: "failure", mismatches: ["securityToken"] });
    expect((await submit("declined")).status).toBe(303);
    expect(await verify()).toMatchObject({ status: "success" });
  });

  test("records one concurrent decision and keeps declines retryable", async () => {
    const racy = await createSession();
    const responses = await Promise.all([
      racy.submit("declined"),
      racy.submit("approved"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([303, 303]);
    const [winner] = await racy.read();
    expect(["approved", "declined"]).toContain(winner?.outcome);
    expect(winner?.decidedAt).not.toBeNull();
    await racy.submit(winner?.outcome === "declined" ? "approved" : "declined");
    expect(await racy.read()).toEqual([winner]);

    const declined = await createSession();
    expect((await declined.submit("declined")).status).toBe(303);
    expect(await declined.verify()).toMatchObject({
      status: "failure",
      terminalState: "failed",
      providerStatus: "declined",
      failureCode: "mock_payment_failed",
    });
    expect(await declined.lookup()).toMatchObject({
      hasActivity: true,
      canRetry: true,
    });
  });

  test("reports provider-side cancellations and refunds on repeated reads", async () => {
    const cancelled = await createSession();
    await run(
      database.db
        .update(mockPaymentSessions)
        .set({ cancelledAt: sql`now()` })
        .where(
          eq(mockPaymentSessions.paymentId, cancelled.session.providerOrderId)
        )
    );
    expect((await cancelled.submit("approved")).status).toBe(303);
    expect(await cancelled.verify()).toMatchObject({
      status: "failure",
      terminalState: "cancelled",
      providerStatus: "canceled",
    });
    expect(await cancelled.lookup()).toMatchObject({ canRetry: true });

    const refunded = await createSession();
    await refunded.submit("approved");
    await run(
      database.db
        .update(mockPaymentSessions)
        .set({
          refundedAt: sql`now()`,
          refundedAmountMinor: input.amount.value,
        })
        .where(
          eq(mockPaymentSessions.paymentId, refunded.session.providerOrderId)
        )
    );
    const lookup = await refunded.lookup();
    expect(lookup).toMatchObject({
      canRetry: false,
      refund: {
        amount: input.amount.value,
        lastRefundedAt: expect.any(String),
      },
    });
    expect(lookup.refund?.operationIds).toHaveLength(1);
    expect(await refunded.lookup()).toEqual(lookup);
  });
});
