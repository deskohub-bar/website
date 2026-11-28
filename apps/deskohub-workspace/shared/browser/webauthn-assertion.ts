import {
  type AuthenticationResponseJSON,
  base64URLStringToBuffer,
  bufferToBase64URLString,
  type PublicKeyCredentialDescriptorFuture,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

// WebAuthn types a descriptor's transports as DOMString values, so a browser
// skips the ones it doesn't know; TypeScript's DOM lib lists only five of the
// transports a passkey can record, without `smart-card`. Seen through this
// method signature, `navigator.credentials` accepts every transport.
type PasskeyCredentials = {
  get(
    options?: Omit<CredentialRequestOptions, "publicKey"> & {
      readonly publicKey?: Omit<
        PublicKeyCredentialRequestOptions,
        "allowCredentials"
      > & {
        readonly allowCredentials?: PublicKeyCredentialDescriptorFuture[];
      };
    }
  ): Promise<Credential | null>;
};

/** A passkey assertion as the server verifies it. */
export type PasskeyAssertion = Omit<
  AuthenticationResponseJSON,
  "clientExtensionResults"
>;

// Conditional requests need an empty allow list, and an empty one would
// block a modal request.
const toAllowCredentials = (
  { allowCredentials }: PublicKeyCredentialRequestOptionsJSON,
  conditional: boolean
): PublicKeyCredentialDescriptorFuture[] | undefined => {
  if (conditional) return [];
  if (!allowCredentials?.length) return undefined;
  return allowCredentials.map((descriptor) => ({
    ...descriptor,
    id: base64URLStringToBuffer(descriptor.id),
  }));
};

/**
 * Asks the browser for a passkey assertion for the server's request options,
 * as `startAuthentication` from `@simplewebauthn/browser` does, but under the
 * caller's `signal`. That library aborts its previous request only when it
 * starts the next, after an asynchronous autofill check, so it can't cancel a
 * request that hasn't started yet. `conditional` offers the passkeys in the
 * autofill of a `webauthn` field and waits until the customer picks one; the
 * caller checks that the browser supports it first. Rejects with the
 * browser's error.
 */
export const getPasskeyAssertion = async (
  options: PublicKeyCredentialRequestOptionsJSON,
  {
    conditional,
    signal,
  }: { readonly conditional: boolean; readonly signal: AbortSignal }
): Promise<PasskeyAssertion> => {
  const credentials: PasskeyCredentials = navigator.credentials;
  const credential = await credentials.get({
    mediation: conditional ? "conditional" : undefined,
    publicKey: {
      ...options,
      challenge: base64URLStringToBuffer(options.challenge),
      allowCredentials: toAllowCredentials(options, conditional),
    },
    signal,
  });
  if (credential === null) throw new Error("No passkey was picked.");
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("The browser returned a credential that isn't a passkey.");
  }
  const {
    id,
    rawId,
    response: assertion,
    authenticatorAttachment,
  } = credential;
  if (!(assertion instanceof AuthenticatorAssertionResponse)) {
    throw new Error("The browser returned a passkey without an assertion.");
  }
  return {
    id,
    rawId: bufferToBase64URLString(rawId),
    response: {
      authenticatorData: bufferToBase64URLString(assertion.authenticatorData),
      clientDataJSON: bufferToBase64URLString(assertion.clientDataJSON),
      signature: bufferToBase64URLString(assertion.signature),
      userHandle: assertion.userHandle
        ? bufferToBase64URLString(assertion.userHandle)
        : undefined,
    },
    type: "public-key",
    authenticatorAttachment:
      authenticatorAttachment === "platform" ||
      authenticatorAttachment === "cross-platform"
        ? authenticatorAttachment
        : undefined,
  };
};
