import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  type CampaignEmailSourceType,
  makeAudienceFilterSchemas,
} from "@deskohub/workspace-admin-api";
import { Effect, Layer, Option, Result, Schema } from "effect";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { describeCountCondition } from "./admin/audience-filter-summary";
import type { AudienceCountWording } from "./admin/audiences/audience-attribute-wording";
import { newConditionFrom } from "./admin/audiences/audience-filter-editing";
import {
  extendedCatalogue,
  extendedResolvers,
  giftCardCount,
  sourcedEmailCount,
  sourcedResolvers,
} from "./audience-attribute-extension.typecheck";
import { audienceFactKey, countFactRequest } from "./audience-filter";
import {
  AudienceScope,
  audienceEvaluationAt,
} from "./backend/audience-evaluation-context";
import { CampaignCandidateRepository } from "./backend/campaign-candidate.repository";
import { campaignIdSchema } from "./campaign-identifiers";
import { datePeriodBounds } from "./date-period";

registerWorkspaceComponentTestEnv();
// @testing-library/react must load after the happy-dom registration.
const { cleanup, render } = await import("@testing-library/react");
const { CountConditionControls } = await import(
  "./admin/audiences/audience-condition-controls"
);

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

const { filter: extendedFilter } = makeAudienceFilterSchemas(extendedCatalogue);
const condition = newConditionFrom(giftCardCount);

/** The Admin UI words an added attribute brings with its entry. */
const giftCardCountWording: AudienceCountWording = {
  kind: "count",
  label: "Gift cards bought",
  lead: [{ text: "gift cards bought" }],
  choices: {},
  period: "Gift cards",
  count: "Gift card count",
  summary: {
    noun: (_params, count) => (count === 1 ? "gift card" : "gift cards"),
    period: (_params, period) => period,
    none: ({ none, period }) => `bought no ${none}${period}`,
    any: ({ none, period }) => `bought any ${none}${period}`,
    amount: (amount, period) => `bought ${amount}${period}`,
  },
};

describe("a count attribute added as one catalogue entry and its resolver", () => {
  test("defaults to its entry's condition, which the wire schema decodes", () => {
    expect(condition).toEqual({
      attribute: "giftCardCount",
      _tag: "Condition",
      params: { period: { _tag: "Last", count: 30, unit: "day" } },
      operator: "gte",
      value: 2,
    });
    expect(
      JSON.stringify(
        Schema.encodeSync(extendedFilter)(
          Schema.decodeUnknownSync(extendedFilter)(condition)
        )
      )
    ).toBe(
      '{"attribute":"giftCardCount","_tag":"Condition","params":{"period":{"_tag":"Last","count":30,"unit":"day"}},"operator":"gte","value":2}'
    );
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(extendedFilter)({
          ...condition,
          operator: "lt",
          value: 0,
        })
      )
    ).toBe(true);
  });

  test("reads in the summary from its wording", () => {
    expect(
      describeCountCondition(condition, giftCardCountWording, "en-US")
    ).toBe("bought at least 2 gift cards in the last 30 days");
    expect(
      describeCountCondition(
        { ...condition, operator: "eq", value: 0 },
        giftCardCountWording,
        "en-US"
      )
    ).toBe("bought no gift cards in the last 30 days");
  });

  test("resolves its counts through its resolver", async () => {
    const context = audienceEvaluationAt(Temporal.Now.instant());
    const request = countFactRequest(giftCardCount, condition, context);
    expect(audienceFactKey(request)).toContain('"giftCardCount"');
    expect(request.fixedParams.period).toEqual(
      datePeriodBounds(condition.params.period, context)
    );
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const candidates = yield* CampaignCandidateRepository;
        return yield* extendedResolvers.giftCardCount.count(
          { params: request.condition.params, inContext: request.inContext },
          {
            candidates,
            scope: AudienceScope.All(),
            visitsIn: () => Effect.die("Unexpected visit lookup"),
            visitEndsIn: () => Effect.die("Unexpected visit end lookup"),
            pastVisits: () => Effect.die("Unexpected past visit lookup"),
          }
        );
      }).pipe(Effect.provide(Layer.mock(CampaignCandidateRepository, {})))
    );
    expect([...counts.values()]).toEqual([3]);
  });

  test("fixes a campaign source of any name by its part", async () => {
    const evaluatingCampaign = campaignIdSchema.make("campaign-1");
    const context = {
      ...audienceEvaluationAt(Temporal.Now.instant()),
      campaignId: Option.some(evaluatingCampaign),
    };
    const sourced = (source: CampaignEmailSourceType) => ({
      ...newConditionFrom(sourcedEmailCount),
      params: {
        campaign: "welcome" as const,
        period: { _tag: "AnyTime" } as const,
        source,
      },
    });
    const fromThis = countFactRequest(
      sourcedEmailCount,
      sourced({ _tag: "This" }),
      context
    );
    expect(fromThis.fixedParams.source).toBe(evaluatingCampaign);
    // The same campaign by name shares the lookup; another doesn't.
    expect(audienceFactKey(fromThis)).toBe(
      audienceFactKey(
        countFactRequest(
          sourcedEmailCount,
          sourced({ _tag: "Specific", campaignId: evaluatingCampaign }),
          context
        )
      )
    );
    expect(audienceFactKey(fromThis)).not.toBe(
      audienceFactKey(
        countFactRequest(sourcedEmailCount, sourced({ _tag: "This" }), {
          ...context,
          campaignId: Option.none(),
        })
      )
    );
    // The choice named `campaign` stays part of the lookup.
    expect(audienceFactKey(fromThis)).not.toBe(
      audienceFactKey(
        countFactRequest(
          sourcedEmailCount,
          {
            ...fromThis.condition,
            params: { ...fromThis.condition.params, campaign: "promotion" },
          },
          context
        )
      )
    );
    const counts = await Effect.runPromise(
      sourcedResolvers.sourcedEmailCount.count({
        params: fromThis.condition.params,
        inContext: fromThis.inContext,
      })
    );
    expect([...counts.keys()].map(String)).toEqual([
      `welcome:${evaluatingCampaign}`,
    ]);
  });

  test("edits with the shared count controls, worded by its wording", () => {
    const view = render(
      <CountConditionControls
        entry={giftCardCount}
        wording={giftCardCountWording}
        value={condition}
        onChange={() => undefined}
        errorAt={() => undefined}
      />
    );
    expect(view.container.textContent).toContain("Number of");
    expect(view.container.textContent).toContain("gift cards bought");
    expect(
      view.getByRole("combobox", { name: "Gift card count comparison" })
    ).toBeDefined();
    expect(
      view.getByRole("spinbutton", { name: "Gift card count" })
    ).toBeDefined();
  });
});
