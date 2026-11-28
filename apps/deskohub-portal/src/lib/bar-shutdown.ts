export const portalPreviewTimeParam = "asOf";

// Midnight on December 1 in Europe/Prague.
const barClosesAt = Date.parse("2026-12-01T00:00:00+01:00");
const privateCacheControl = "private, no-store";
const closedCacheControl =
  "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";
const openCacheLimitSeconds = 3600;
// Let the last cached open response expire before the cutoff, allowing for
// response transit and the CDN's whole-second cache accounting.
const cacheCutoffBufferSeconds = 60;

const previewTimestampPattern =
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

type BarStateRequest = {
  now: number;
  previewAsOf: string | null;
  vercelEnv: string | undefined;
  isDev: boolean;
};

export function getBarState({
  now,
  previewAsOf,
  vercelEnv,
  isDev,
}: BarStateRequest) {
  const allowPreview =
    vercelEnv !== "production" && (vercelEnv === "preview" || isDev);
  const previewTime = allowPreview ? parsePreviewTime(previewAsOf) : undefined;
  const barClosed = (previewTime ?? now) >= barClosesAt;

  if (previewTime !== undefined) {
    return { barClosed, cacheControl: privateCacheControl };
  }

  if (barClosed) {
    return { barClosed, cacheControl: closedCacheControl };
  }

  const secondsUntilCutoff = Math.floor((barClosesAt - now) / 1000);
  const maxAge = Math.min(
    openCacheLimitSeconds,
    secondsUntilCutoff - cacheCutoffBufferSeconds
  );
  return {
    barClosed,
    cacheControl:
      maxAge > 0
        ? `public, max-age=0, must-revalidate, s-maxage=${maxAge}`
        : privateCacheControl,
  };
}

function parsePreviewTime(value: string | null) {
  const date = value?.match(previewTimestampPattern)?.[1];
  if (!(value && date)) {
    return;
  }

  const time = Date.parse(value);
  // Date.parse normalizes some invalid calendar days, such as February 30.
  if (
    Number.isFinite(time) &&
    new Date(`${date}T00:00:00Z`).toISOString().startsWith(date)
  ) {
    return time;
  }
}
