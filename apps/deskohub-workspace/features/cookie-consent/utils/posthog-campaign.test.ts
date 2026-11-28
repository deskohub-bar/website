import { describe, expect, test } from "bun:test";
import {
  isPostHogCampaignProperty,
  readPageviewCampaignProperties,
} from "./posthog-campaign";

const pageUrl = new URL("https://workspace.example.test/landing");

describe("PostHog pageview campaign properties", () => {
  test.each([
    ["42", { utm_id: "42" }],
    ["123456", { utm_id: "123456" }],
    ["1234567", {}],
    ["123456789012345", {}],
    ["spring-42", { utm_id: "spring-42" }],
    ["campaign-777-123-456", {}],
    ["3cbe8b913f", {}],
  ])("validates manual campaign ID %s", (value, expected) => {
    const url = new URL(pageUrl.href);
    url.searchParams.set("utm_id", value);
    expect(readPageviewCampaignProperties(url)).toEqual(expected);
  });

  test("keeps multilingual labels whole and drops ambiguous fields", () => {
    const url = new URL(pageUrl.href);
    url.searchParams.set("utm_campaign", "bud jako doma");
    url.searchParams.set("utm_term", "sdílená kancelář");
    url.searchParams.set("utm_source", "first");
    url.searchParams.set("UTM_SOURCE", "second");
    url.searchParams.set("utm_medium", "print");
    url.searchParams.set("utm_medium[]", "radio");
    url.searchParams.set("utm_content", "a".repeat(129));
    url.searchParams.set("utm_source_platform", "hidden\u200bwords");
    url.searchParams.set("utm_creative_format", "first%20word");
    url.searchParams.set("utm_marketing_tactic", "example.invalid");
    expect(readPageviewCampaignProperties(url)).toEqual({
      utm_campaign: "bud jako doma",
      utm_term: "sdílená kancelář",
    });
  });

  test("reserves the document entry for an untagged pageview", () => {
    const entry = () => `${pageUrl.href}?utm_source=entry&utm_medium=qr`;
    expect(readPageviewCampaignProperties(pageUrl, entry)).toEqual({
      utm_medium: "qr",
      utm_source: "entry",
    });
    expect(readPageviewCampaignProperties(pageUrl)).toBeUndefined();
    expect(
      readPageviewCampaignProperties(pageUrl, () => "malformed")
    ).toBeUndefined();
    expect(
      readPageviewCampaignProperties(
        pageUrl,
        () => "https://other.example.test/?utm_source=entry"
      )
    ).toBeUndefined();
    expect(
      readPageviewCampaignProperties(
        new URL("?utm_source=current", pageUrl),
        entry
      )
    ).toEqual({ utm_source: "current" });
    expect(
      readPageviewCampaignProperties(
        new URL("?utm_id=123456789", pageUrl),
        entry
      )
    ).toEqual({});
    expect(
      readPageviewCampaignProperties(
        new URL("?gclid=synthetic", pageUrl),
        entry
      )
    ).toEqual({});
  });

  test.each(["aw.ds", "ds", "3p.ds"])(
    "allows documented gclsrc %s",
    (value) => {
      const url = new URL(pageUrl.href);
      url.searchParams.set("gclsrc", value);
      expect(readPageviewCampaignProperties(url)).toEqual({ gclsrc: value });
    }
  );

  test.each([
    "$entry_utm_id",
    "$entry_gad_campaignid",
    "$session_entry_$fbc",
    "$initial_fbp_persistence",
    "_fbp",
    "$fbc",
    "$fbc_persistence",
    "$session_entry_rdt_cid",
    "$initial_campaign_params",
  ])("filters SDK property %s", (key) => {
    expect(isPostHogCampaignProperty(key)).toBe(true);
  });
});
