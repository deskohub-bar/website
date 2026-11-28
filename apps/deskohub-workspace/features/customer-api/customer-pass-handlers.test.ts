import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { PostHogFeatureFlagEvaluationError } from "@deskohub/analytics-posthog/feature-flags/node";
import { Effect, Layer } from "effect";
import { releaseGateForRunOverFlags } from "@/features/feature-flags/backend/release-cohorts.test-utils";
import { WorkspaceFeatureFlagService } from "@/features/feature-flags/backend/workspace-feature-flag.service";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import {
  answerInEachReleaseCohort,
  type CustomerApiCall,
  currentAccountResolving,
  customerApiRequest,
  expectEachCohortAnsweredAlone,
  inReleaseCohort,
  makeCustomerApiTestServer,
  testCustomerEndpointGuards,
} from "./customer-api.test-utils";

const catalog = { method: "GET", path: "/passes/catalog" } as const;
const passId = "019acbf0-0000-7000-8000-000000000011";

describe("customer pass reads", () => {
  testCustomerEndpointGuards(catalog);

  test("withholds the catalog when PostHog cannot evaluate the release", async () => {
    const flags = Layer.mock(WorkspaceFeatureFlagService, {
      isEnabled: () =>
        Effect.fail(
          new PostHogFeatureFlagEvaluationError({
            message: "Fixture flag evaluation omitted the release.",
          })
        ),
    });
    const api = makeCustomerApiTestServer({
      passes: {
        release: releaseGateForRunOverFlags(CoworkPassesReleaseGate, flags),
      },
    });
    const response = await api.handle(customerApiRequest(catalog));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      _tag: "CustomerPassesUnavailable",
    });
  });

  test("catalog answers only requests in the open release cohort", async () => {
    const answers = await answerInEachReleaseCohort({
      serve: (flags) =>
        makeCustomerApiTestServer({
          reservations: {
            currentAccount: currentAccountResolving((session) => ({
              kind: "profile-missing",
              session,
              reviewMarker: "absent",
            })),
          },
          passes: {
            release: releaseGateForRunOverFlags(CoworkPassesReleaseGate, flags),
          },
        }),
      send: (cohort) => customerApiRequest(inReleaseCohort(catalog, cohort)),
    });
    expectEachCohortAnsweredAlone(answers);
    expect(answers.alone.closed).toEqual({
      status: 404,
      body: { _tag: "CustomerPassesUnavailable" },
    });
    expect(answers.alone.open).toMatchObject({
      status: 200,
      body: {
        entryPacks: expect.arrayContaining([
          {
            product: { kind: "entry-pack", tier: "open-space", size: 5 },
            price: { value: 115000, exponent: 2, currency: "CZK" },
            validityMonths: 2,
          },
        ]),
      },
    });
  });

  for (const call of [
    ...[
      "/passes",
      "/passes/options?date=2026-11-25&tier=open-space",
      `/passes/${passId}/access`,
      `/passes/reservation-funding?orderIds=${passId}`,
      "/passes/unlimited/start-dates",
      `/passes/purchases/${passId}`,
    ].map((path) => ({ method: "GET" as const, path })),
    {
      method: "POST",
      path: `/passes/${passId}/invitation`,
    },
    {
      method: "POST",
      path: "/passes/purchases",
      body: {
        orderId: passId,
        locale: "en-US",
        product: { kind: "entry-pack", tier: "open-space", size: 5 },
      },
    },
    {
      method: "POST",
      path: `/passes/purchases/${passId}/payment`,
      body: {
        productKind: "entry-pack",
        accepted: false,
        acceptedDocuments: [],
        displayedPriceFingerprint: "0".repeat(64),
      },
    },
    {
      method: "PATCH",
      path: `/passes/purchases/${passId}/price`,
      body: {
        productKind: "entry-pack",
        displayedPriceFingerprint: "0".repeat(64),
      },
    },
  ] satisfies readonly CustomerApiCall[]) {
    test(`closed passes withhold ${call.method} ${call.path.split("?")[0]}`, async () => {
      const api = makeCustomerApiTestServer();
      const response = await api.handle(customerApiRequest(call));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        _tag: "CustomerPassesUnavailable",
      });
    });
  }
});
