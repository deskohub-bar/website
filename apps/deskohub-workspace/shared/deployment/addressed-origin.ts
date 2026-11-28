import type { RuntimeHost } from "./runtime-host";

/** The parts of a proxy request that say where the client sent it. */
export interface AddressedRequest {
  readonly headers: Headers;
  readonly nextUrl: {
    readonly host: string;
    readonly origin: string;
    readonly protocol: string;
  };
}

/** The scheme and host a client sent a request to. */
export interface AddressedOrigin {
  readonly host: string;
  readonly origin: string;
}

/**
 * Where the client sent a request. On Vercel the request URL says so: its
 * edge hands Next the host the client visited. A container's server builds
 * the request URL from its own listen address (`HOSTNAME` and `PORT`, such as
 * `0.0.0.0:8080`), so there the host comes from `Host`, by which the trusted
 * ingress that container hosts require routes the request, and the scheme
 * from the URL's protocol, which Next derives from `X-Forwarded-Proto` behind
 * TLS termination. `X-Forwarded-Host` stays unread because a client can set
 * it. Callers only compare the result with a configured origin and redirect
 * to that origin, never to a host a header names.
 */
export const addressedOrigin = (
  request: AddressedRequest,
  runtimeHost: RuntimeHost | undefined
): AddressedOrigin => {
  if (runtimeHost !== "container") return request.nextUrl;
  const host = request.headers.get("host");
  return (
    (host && URL.parse(`${request.nextUrl.protocol}//${host}`)) ||
    request.nextUrl
  );
};
