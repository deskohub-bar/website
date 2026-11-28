import type { Page } from "@playwright/test";
import { Effect, Layer } from "effect";
import { makeTestDatabaseClient } from "@/shared/testing/workspace-recording-database.test-utils";
import { getConfig } from "../config";
import { WorkspaceE2EHostedPaymentPermitServiceMock } from "../coordination/hosted-payment-permit.service.mock";
import { WorkspaceE2EProviderVerificationPermitServiceMock } from "../coordination/provider-verification-permit.service.mock";
import { makeTestE2EEnvironment } from "../e2e-env.test-fixture";
import { E2EDatabase } from "../integrations/database.service";

export const makeTestE2EConfig = (baseUrl: string) => ({
  ...getConfig(makeTestE2EEnvironment()),
  baseUrl,
  expectedHost: new URL(baseUrl).host,
});

export const unopenedE2EDatabase = Layer.effect(
  E2EDatabase,
  Effect.map(
    makeTestDatabaseClient(
      Effect.die(new Error("unexpected E2E database access"))
    ),
    (db) => ({ db })
  )
);

// Unbound cases still declare the bound case's services in their contract.
export const unboundCaseServices = Layer.mergeAll(
  unopenedE2EDatabase,
  WorkspaceE2EHostedPaymentPermitServiceMock,
  WorkspaceE2EProviderVerificationPermitServiceMock
);

declare const pageEvaluate: Page["evaluate"];
export type PageEvaluation<Arg, A> = Parameters<typeof pageEvaluate<A, Arg>>[0];
