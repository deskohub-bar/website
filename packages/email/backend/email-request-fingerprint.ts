import { createHash, createHmac } from "node:crypto";

/** Binds a request to the same route and credentials without recording either. */
export const emailRequestFingerprint = (
  request: readonly unknown[],
  credential?: string
): string =>
  (credential === undefined
    ? createHash("sha256")
    : createHmac("sha256", credential)
  )
    .update(JSON.stringify(request))
    .digest("hex");
