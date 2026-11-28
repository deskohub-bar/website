import { definePostHogFeatureFlags } from "@deskohub/analytics-posthog/feature-flags";
import { Schema } from "effect";

/** Generated from PostHog feature flag definitions. Do not edit manually. */
export const postHogFeatureFlags = definePostHogFeatureFlags<
  PostHogFeatureFlagDefinitions
>({
  "account_avatars": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "agent_booking": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "calendar_sales": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "cowork_passes": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "customer_discounts": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "discount_codes": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "login_email_code": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "login_passkeys": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "meeting_room_page": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "office_page": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "online_withdrawal": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "overnight_stays": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "referrals": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "seating_map": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "team_table_page": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
  "webmcp_site_tools": {
    payload: Schema.Undefined,
    value: Schema.Boolean,
  },
});

export type PostHogFeatureFlagKey =
  (typeof postHogFeatureFlags.keys)[number];

export interface PostHogFeatureFlagDefinitions {
  readonly "account_avatars": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "agent_booking": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "calendar_sales": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "cowork_passes": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "customer_discounts": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "discount_codes": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "login_email_code": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "login_passkeys": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "meeting_room_page": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "office_page": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "online_withdrawal": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "overnight_stays": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "referrals": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "seating_map": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "team_table_page": {
    readonly value: boolean;
    readonly payload: undefined;
  };
  readonly "webmcp_site_tools": {
    readonly value: boolean;
    readonly payload: undefined;
  };
}

export type PostHogFeatureFlagValue<
  Key extends PostHogFeatureFlagKey,
> = PostHogFeatureFlagDefinitions[Key]["value"];

export type PostHogFeatureFlagPayload<
  Key extends PostHogFeatureFlagKey,
> = PostHogFeatureFlagDefinitions[Key]["payload"];
