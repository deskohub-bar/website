"use client";

import type { PostHogFeatureFlagOverrides } from "@deskohub/analytics-posthog/feature-flags";
import { Analytics } from "@vercel/analytics/react";
import type { PostHogFeatureFlagDefinitions } from "@/features/feature-flags/generated/contract";
import { isEntryPackGiftSignInDocument } from "@/features/passes/entry-pack-gift-sign-in.browser";
import { useClientReady } from "@/shared/browser/use-client-ready";
import type { DeploymentEnvironment } from "@/shared/deployment/deployment-stage";
import { sanitizeVercelAnalyticsEvent } from "../utils/vercel-analytics";
import { useVisitorConsent } from "../visitor-consent";
import { PostHogAnalytics } from "./posthog-analytics";

type ConsentAwareAnalyticsProps = {
  featureFlagOverrides?: PostHogFeatureFlagOverrides<PostHogFeatureFlagDefinitions>;
  posthogEnvironment: DeploymentEnvironment;
};

export function ConsentAwareAnalytics({
  featureFlagOverrides,
  posthogEnvironment,
}: ConsentAwareAnalyticsProps) {
  const analyticsAccepted = useVisitorConsent("analytics");
  const ready = useClientReady();
  if (!ready || isEntryPackGiftSignInDocument()) return null;

  return (
    <PostHogAnalytics
      analyticsAccepted={analyticsAccepted}
      featureFlagOverrides={featureFlagOverrides}
      posthogEnvironment={posthogEnvironment}
    >
      {analyticsAccepted && (
        <Analytics beforeSend={sanitizeVercelAnalyticsEvent} />
      )}
    </PostHogAnalytics>
  );
}
