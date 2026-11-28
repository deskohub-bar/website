import "@/shared/testing/workspace-test-env";

import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { env } from "@/env";
import { runWorkspaceEffect } from "@/shared/backend/workspace-effect";
import { PaymentProviders } from "./payment-provider";
import { PaymentProvidersLive } from "./payment-providers";

test("builds the production payment providers without a mock database layer", async () => {
  const previous = {
    VERCEL_ENV: env.VERCEL_ENV,
    WORKSPACE_PAYMENT_PROVIDER: env.WORKSPACE_PAYMENT_PROVIDER,
  };
  const database = WorkspaceDatabase.Default;
  try {
    Object.assign(env, {
      VERCEL_ENV: "production",
      WORKSPACE_PAYMENT_PROVIDER: "nexi",
    });
    WorkspaceDatabase.Default = Layer.effect(
      WorkspaceDatabase,
      Effect.die(
        new Error("Production payment providers must not build the database.")
      )
    );

    const run = runWorkspaceEffect("test.productionPaymentProviders");
    const providers = await run(
      PaymentProviders.pipe(Effect.provide(PaymentProvidersLive))
    );

    expect(providers.activeProviders).toEqual(["nexi"]);
    expect(
      await run(providers.selectForCustomer({ name: "Test Customer" }))
    ).toBe("nexi");
  } finally {
    WorkspaceDatabase.Default = database;
    Object.assign(env, previous);
  }
});
