import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { preparePostHogEvent } from "./posthog-event";

const createEvent = (
  event: string,
  properties: Parameters<typeof preparePostHogEvent>[0]["properties"]
) => ({
  uuid: "019ee060-bc9f-7070-aea9-9440835fe38f",
  event,
  properties,
});

describe("preparePostHogEvent", () => {
  test("sanitizes documented initial URLs in top-level person-property bags", () => {
    const event = {
      ...createEvent("workspace page viewed", {
        $current_url: `https://workspace.deskohub.cz/account?email=${encodeURIComponent(testEmailAddress("synthetic"))}#name`,
      }),
      $set_once: {
        $initial_current_url:
          "https://workspace.deskohub.cz/checkout/pay/return/order-id?token=synthetic-token#billing",
        $initial_pathname:
          "/reservation/invoice/synthetic-reservation-id?billing=synthetic-billing#synthetic-fragment",
      },
    };

    const preparedEvent = preparePostHogEvent(event, "production");

    expect(preparedEvent).toBe(event);
    expect(preparedEvent?.properties).toEqual({
      $current_url: "https://workspace.deskohub.cz/account",
      "deployment.environment.name": "production",
    });
    expect(preparedEvent?.$set_once).toEqual({
      $initial_current_url:
        "https://workspace.deskohub.cz/checkout/pay/return/[id]",
      $initial_pathname: "/reservation/invoice/[id]",
    });
    for (const privateValue of [
      testEmailAddress("synthetic"),
      "synthetic-token",
      "billing",
      "synthetic-fragment",
    ]) {
      expect(JSON.stringify(preparedEvent)).not.toContain(privateValue);
    }
  });

  test("drops referrer fields from event properties and both person setters", () => {
    const referrer = "https://synthetic.test/private-path?q=marker#fragment";
    const referrerProperties = {
      $referrer: "$direct",
      $referring_domain: "synthetic.test",
      $initial_referrer: referrer,
      $initial_referring_domain: "synthetic.test",
      $session_entry_referrer: referrer,
      $session_entry_referring_domain: "synthetic.test",
      $search_engine: "google",
      ph_keyword: "synthetic-customer-name",
      $initial_search_engine: "google",
      $initial_ph_keyword: "synthetic-customer-name",
      $session_entry_search_engine: "google",
      $session_entry_ph_keyword: "synthetic-customer-name",
      $prev_pageview_pathname: "/private-path",
    };
    const event = {
      ...createEvent("$pageview", {
        ...referrerProperties,
        $set: { ...referrerProperties, dotypos_customer_id: "customer-id" },
        $set_once: referrerProperties,
        $prev_pageview_id: "previous-pageview-id",
        $session_id: "session-id",
        $window_id: "window-id",
        referrer_type: "internal",
      }),
      $set: referrerProperties,
      $set_once: referrerProperties,
    };

    expect(preparePostHogEvent(event, "production")).toEqual({
      ...createEvent("$pageview", {
        $set: { dotypos_customer_id: "customer-id" },
        $set_once: {},
        $prev_pageview_id: "previous-pageview-id",
        $session_id: "session-id",
        $window_id: "window-id",
        referrer_type: "internal",
        "deployment.environment.name": "production",
      }),
      $set: {},
      $set_once: {},
    });
  });
});
