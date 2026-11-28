import { describe, expect, test } from "bun:test";
import {
  AutomationFlow,
  AutomationStepId,
} from "@deskohub/workspace-admin-api";
import { Option, Predicate, Schema } from "effect";
import { type AudienceFilter, audienceFilterSchema } from "../audience-filter";
import {
  type CampaignLocalizedContent,
  CampaignPurpose,
  CampaignTemplateKey,
  campaignLocalizedContent,
} from "../body/campaign-content";
import { campaignAudienceIdSchema } from "../campaign-identifiers";
import {
  type AutomationPublishableCopy,
  hashAutomationDraft,
} from "./automation-draft-hash";

const body = (text: string) => ({
  formatVersion: 1 as const,
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  },
});

const content: CampaignLocalizedContent = {
  "cs-CZ": { subject: "Vraťte se", preheader: "Sleva", body: body("Ahoj") },
  "en-US": { subject: "Come back", preheader: "Offer", body: body("Hi") },
};

const flow: AutomationFlow = {
  trigger: {
    _tag: "Schedule",
    calendar: { minutes: [0], hours: [9], weekdays: ["monday", "friday"] },
  },
  steps: [
    {
      _tag: "Condition",
      id: AutomationStepId.make("regulars"),
      filter: {
        _tag: "InAudience",
        audienceId: campaignAudienceIdSchema.make("regulars"),
        operator: "in",
      },
    },
    {
      _tag: "Wait",
      id: AutomationStepId.make("wait"),
      wait: { _tag: "Duration", count: 2, unit: "day" },
    },
    { _tag: "Send", id: AutomationStepId.make("send") },
  ],
};

const audienceFilter: AudienceFilter = {
  _tag: "Group",
  operator: "and",
  filters: [
    {
      attribute: "locale",
      _tag: "Condition",
      operator: "anyOf",
      value: ["cs-CZ"],
    },
  ],
};

const copy: AutomationPublishableCopy = {
  purpose: "marketing",
  templateKey: "workspace",
  content,
  flow,
  audienceFilter,
};

const publishableCopy = Schema.Struct({
  purpose: CampaignPurpose,
  templateKey: CampaignTemplateKey,
  content: campaignLocalizedContent(Option.none()),
  flow: AutomationFlow,
  audienceFilter: audienceFilterSchema,
});

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
  Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value);

/** The same value with every object's keys in reverse order. */
const reverseKeys = (value: Schema.Json): Schema.Json => {
  if (isJsonArray(value)) {
    return value.map(reverseKeys);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)])
    );
  }
  return value;
};

describe("hashAutomationDraft", () => {
  test("is a SHA-256 hex digest", () => {
    expect(hashAutomationDraft(copy)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ignores key order", () => {
    const reordered = reverseKeys(copy);
    if (!Schema.is(publishableCopy)(reordered)) {
      throw new Error("Reordered copy no longer matches the campaign schema");
    }
    expect(hashAutomationDraft(reordered)).toBe(hashAutomationDraft(copy));
  });

  test("ignores the order of calendar values", () => {
    const reordered: AutomationFlow = {
      ...flow,
      trigger: {
        _tag: "Schedule",
        calendar: { weekdays: ["friday", "monday"], hours: [9], minutes: [0] },
      },
    };
    expect(hashAutomationDraft({ ...copy, flow: reordered })).toBe(
      hashAutomationDraft(copy)
    );
  });

  test.each<[string, Parameters<typeof hashAutomationDraft>[0]]>([
    [
      "the flow",
      {
        ...copy,
        flow: {
          ...flow,
          steps: flow.steps.map((step) =>
            step._tag === "Wait"
              ? { ...step, wait: { _tag: "Duration", count: 3, unit: "day" } }
              : step
          ),
        },
      },
    ],
    [
      "a saved audience the flow names",
      {
        ...copy,
        flow: {
          ...flow,
          steps: flow.steps.map((step) =>
            step._tag === "Condition"
              ? {
                  ...step,
                  filter: {
                    _tag: "InAudience",
                    audienceId: campaignAudienceIdSchema.make("lapsed"),
                    operator: "in",
                  },
                }
              : step
          ),
        },
      },
    ],
    [
      "the content",
      {
        ...copy,
        content: {
          ...content,
          "en-US": {
            subject: "Come back soon",
            preheader: "Offer",
            body: body("Hi"),
          },
        },
      },
    ],
    ["the purpose", { ...copy, purpose: "operational" }],
    ["the template", { ...copy, templateKey: "other" }],
    [
      "the audience filter",
      {
        ...copy,
        audienceFilter: { ...audienceFilter, operator: "or" },
      },
    ],
  ])("changes with %s", (_, changed) => {
    expect(hashAutomationDraft(changed)).not.toBe(hashAutomationDraft(copy));
  });
});
