import { Option, Predicate } from "effect";
import type { Properties } from "posthog-js";
import { sanitizeAnalyticsUrl } from "@/shared/utils/analytics-url";
import { isPostHogCampaignProperty } from "./posthog-campaign";

const POSTHOG_URL_PROPERTIES = [
  "$current_url",
  "$initial_current_url",
  "$session_entry_url",
] as const;

const POSTHOG_PATH_PROPERTIES = [
  "$pathname",
  "$initial_pathname",
  "$session_entry_pathname",
] as const;

const SYNTHETIC_PATH_ORIGIN = "https://posthog-path.invalid";

// The SDK can attach referrer-derived fields even with save_referrer off.
const POSTHOG_REFERRER_PROPERTIES = new Set([
  "$referrer",
  "$referring_domain",
  "$initial_referrer",
  "$initial_referring_domain",
  "$session_entry_referrer",
  "$session_entry_referring_domain",
  "$search_engine",
  "ph_keyword",
  "$initial_search_engine",
  "$initial_ph_keyword",
  "$session_entry_search_engine",
  "$session_entry_ph_keyword",
  "$prev_pageview_pathname",
]);

function sanitizePostHogUrlObject(url: URL) {
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";

  return url;
}

export function createPostHogPageUrl(href: string) {
  return sanitizePostHogUrlObject(
    new URL(sanitizeAnalyticsUrl(href))
  ).toString();
}

/** The sanitized page URL of `href`, or none when `href` is not a URL. */
export const parsePostHogPageUrl = Option.liftThrowable(createPostHogPageUrl);

const parseSyntheticPathUrl = Option.liftThrowable(
  (path: string) => new URL(path, SYNTHETIC_PATH_ORIGIN)
);

function sanitizePostHogPath(value: string): string | undefined {
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;

  return parseSyntheticPathUrl(value).pipe(
    Option.filter((url) => url.origin === SYNTHETIC_PATH_ORIGIN),
    Option.flatMap((url) => parsePostHogPageUrl(url.toString())),
    Option.map((pageUrl) => new URL(pageUrl).pathname),
    Option.getOrUndefined
  );
}

export function sanitizePostHogUrlProperties(
  properties: Properties | undefined
) {
  const sanitizedProperties: Properties = { ...properties };

  for (const property of Object.keys(sanitizedProperties)) {
    if (
      POSTHOG_REFERRER_PROPERTIES.has(property) ||
      isPostHogCampaignProperty(property)
    ) {
      delete sanitizedProperties[property];
    }
  }

  for (const property of POSTHOG_URL_PROPERTIES) {
    const url = sanitizedProperties[property];
    if (!Predicate.isString(url)) {
      delete sanitizedProperties[property];
      continue;
    }

    const sanitizedUrl = Option.getOrUndefined(parsePostHogPageUrl(url));
    if (sanitizedUrl === undefined) {
      delete sanitizedProperties[property];
    } else {
      sanitizedProperties[property] = sanitizedUrl;
    }
  }

  for (const property of POSTHOG_PATH_PROPERTIES) {
    const path = sanitizedProperties[property];
    if (!Predicate.isString(path)) {
      delete sanitizedProperties[property];
      continue;
    }

    const sanitizedPath = sanitizePostHogPath(path);
    if (sanitizedPath === undefined) {
      delete sanitizedProperties[property];
    } else {
      sanitizedProperties[property] = sanitizedPath;
    }
  }

  return sanitizedProperties;
}

export function sanitizePostHogProperties(
  properties: Properties | undefined,
  posthogEnvironment: string
) {
  const sanitizedProperties = sanitizePostHogUrlProperties(properties);

  for (const property of ["$set", "$set_once"] as const) {
    const nestedProperties = sanitizedProperties[property];
    if (Predicate.isObject(nestedProperties)) {
      sanitizedProperties[property] =
        sanitizePostHogUrlProperties(nestedProperties);
    }
  }

  sanitizedProperties["deployment.environment.name"] = posthogEnvironment;

  return sanitizedProperties;
}
