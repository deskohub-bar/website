import type { BeforeSend } from "@vercel/analytics/react";
import { isEntryPackGiftSignInHash } from "@/features/passes/entry-pack-gift-sign-in";
import { sanitizeAnalyticsUrl } from "@/shared/utils/analytics-url";

export const sanitizeVercelAnalyticsEvent: BeforeSend = (event) => {
  const url = new URL(sanitizeAnalyticsUrl(event.url));
  if (isEntryPackGiftSignInHash(url.hash)) url.hash = "";
  return { ...event, url: url.toString() };
};
