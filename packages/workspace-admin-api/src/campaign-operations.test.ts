import { describe, expect, expectTypeOf, test } from "bun:test";
import { Result, Schema } from "effect";
import { administrationInputParseOptions } from "./administration-input-parse-options";
import type { LedgerOperationName } from "./administration-operation-port";
import { campaignOperations } from "./campaign-operations";

describe("campaign operations", () => {
  test.each([
    ["listCampaigns", {}],
    ["getCampaign", { campaignId: "campaign-1" }],
    [
      "previewCampaignTemplate",
      {
        templateKey: "workspace",
        preview: {
          _tag: "Campaign",
          campaignId: "campaign-1",
          locale: "cs-CZ",
        },
      },
    ],
    ["sendCampaign", { campaignId: "campaign-1", confirmationCode: "code" }],
    [
      "activateAutomation",
      { campaignId: "campaign-1", previewId: "preview-1" },
    ],
    [
      "listAutomationRuns",
      { campaignId: "campaign-1", state: "active", limit: 100 },
    ],
  ] as const)("%s rejects an unknown key", (name, input) => {
    const operationInput: Schema.Decoder<unknown> =
      campaignOperations[name].input;
    const decode = Schema.decodeUnknownResult(
      operationInput,
      administrationInputParseOptions
    );

    expect(Result.isSuccess(decode(input))).toBe(true);
    expect(Result.isFailure(decode({ ...input, unexpected: true }))).toBe(true);
  });

  test("only campaign creation, audience creation and duplication opt into replay", () => {
    const ledgerOperations = [
      "createCampaign",
      "createCampaignAudience",
      "duplicateCampaign",
    ] as const;
    expectTypeOf<
      LedgerOperationName<typeof campaignOperations>
    >().toEqualTypeOf<(typeof ledgerOperations)[number]>();
    expect(
      Object.values(campaignOperations)
        .filter(({ ledger }) => ledger)
        .map(({ name }) => name)
        .sort()
    ).toEqual([...ledgerOperations]);
  });
});
