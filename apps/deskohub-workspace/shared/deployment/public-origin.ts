import { env } from "@/env";
import type { RuntimeHost } from "./runtime-host";

/** The settings that say which origin clients reach a deployment on. */
export interface PublicOriginSettings {
  readonly WORKSPACE_RUNTIME_HOST?: RuntimeHost | undefined;
  readonly WORKSPACE_PUBLIC_ORIGIN?: string | undefined;
}

/**
 * The origin a container's clients reach it on. Its server builds request
 * URLs from its listen address (`0.0.0.0:8080`), which no client can reach,
 * so a container names its public origin, and the deployment's own URLs use
 * that. On Vercel, and in local development, the request URL already has
 * the origin the client visited, so there is none.
 */
export const containerPublicOrigin = (
  settings: PublicOriginSettings
): URL | undefined =>
  settings.WORKSPACE_RUNTIME_HOST === "container" &&
  settings.WORKSPACE_PUBLIC_ORIGIN
    ? new URL(settings.WORKSPACE_PUBLIC_ORIGIN)
    : undefined;

/**
 * Moves a URL derived from a request onto the origin its clients reach, so
 * a redirect or same-origin check never names a container's listen address.
 * The path, query, and fragment stay; only a configured origin replaces the
 * request's, never a host a request header names.
 */
export const toPublicUrl = (url: URL, settings: PublicOriginSettings): URL => {
  const origin = containerPublicOrigin(settings);
  return origin ? withOrigin(url, origin) : new URL(url);
};

/**
 * `url`'s path, query, and fragment on `origin`. They are copied part by
 * part: resolving the path against the origin would read a path such as
 * `//attacker.example` as another host.
 */
export const withOrigin = (
  url: Pick<URL, "pathname" | "search" | "hash">,
  origin: URL
): URL => {
  const result = new URL(origin.origin);
  result.pathname = url.pathname;
  result.search = url.search;
  result.hash = url.hash;
  return result;
};

/**
 * A URL of this deployment that clients can reach, resolved like
 * `new URL(input, base)` from a request's URL.
 */
export const publicUrl = (input: string | URL, base?: string | URL): URL =>
  toPublicUrl(new URL(input, base), env);
