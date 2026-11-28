import { Schema } from "effect";

/**
 * The header Vercel's edge sets to the client address, overwriting any value
 * the client sent.
 */
export const vercelClientAddressHeader = "x-vercel-forwarded-for";

/**
 * Headers a client can append to before a proxy forwards them. Better Auth
 * reads the first address of a list, which is the client's own claim, so
 * neither may name the trusted client address.
 */
const clientAppendableHeaders = new Set(["x-forwarded-for", "forwarded"]);

/**
 * The lowercase name of a header that only the trusted ingress sets, such as
 * a Google load balancer custom request header carrying
 * `{client_ip_address}`, which replaces any client-sent value.
 */
export const trustedClientAddressHeaderSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
  Schema.makeFilter((header) =>
    clientAppendableHeaders.has(header)
      ? "A client can append to this header; name a header the ingress overwrites."
      : undefined
  )
);

export interface TrustedClientAddressSettings {
  /** The header the trusted ingress sets, when the host is not Vercel. */
  readonly WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER?: string | undefined;
  /** Set on every Vercel deployment, so it marks the Vercel host. */
  readonly VERCEL_URL?: string | undefined;
}

/**
 * The headers that carry the client address: the configured ingress header,
 * else Vercel's on Vercel, else none, so a direct request to an origin
 * without a configured ingress never chooses its own address.
 */
export const trustedClientAddressHeaders = (
  settings: TrustedClientAddressSettings
): readonly string[] => {
  if (settings.WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER) {
    return [settings.WORKSPACE_TRUSTED_CLIENT_ADDRESS_HEADER];
  }
  return settings.VERCEL_URL ? [vercelClientAddressHeader] : [];
};
