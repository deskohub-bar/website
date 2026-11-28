import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import assert from "node:assert/strict";
import { getPasskeyAssertion } from "./webauthn-assertion";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const toBytes = (source: BufferSource | undefined): Uint8Array => {
  assert(source !== undefined, "Expected BufferSource");
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
};

// Bun has no WebAuthn globals, so the tests install stand-ins for the
// classes the browser returns.
class TestAssertionResponse {
  readonly authenticatorData = bytes(4);
  readonly clientDataJSON = bytes(5);
  readonly signature = bytes(6);
  readonly userHandle = bytes(7);
}

class TestPublicKeyCredential {
  readonly id = "credential-id";
  readonly rawId = bytes(1, 2, 3);
  readonly type = "public-key";
  readonly authenticatorAttachment = "platform";
  constructor(
    readonly response: TestAssertionResponse | null = new TestAssertionResponse()
  ) {}
}

const webAuthnGlobals = {
  PublicKeyCredential: TestPublicKeyCredential,
  AuthenticatorAssertionResponse: TestAssertionResponse,
};
const originalWebAuthnGlobals = Object.keys(webAuthnGlobals).map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
);

const assertion = new TestPublicKeyCredential();

const get = mock(
  (_options: CredentialRequestOptions): Promise<unknown> =>
    Promise.resolve(assertion)
);
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);

const requestOptions = {
  challenge: "AQID",
  rpId: "workspace.invalid",
  userVerification: "preferred",
  allowCredentials: [
    { id: "BAU", type: "public-key", transports: ["internal"] },
  ],
} as const;

const requested = () => {
  const options = get.mock.calls.at(-1)?.[0];
  if (options?.publicKey === undefined) throw new Error("No request.");
  return { ...options, publicKey: options.publicKey };
};

describe("passkey assertions", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { credentials: { get } },
    });
    for (const [name, value] of Object.entries(webAuthnGlobals)) {
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }
  });

  afterAll(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    for (const [name, original] of originalWebAuthnGlobals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  afterEach(() => {
    get.mockClear();
  });

  test("asks for a modal assertion of the allowed passkeys under the signal", async () => {
    const { signal } = new AbortController();

    await expect(
      getPasskeyAssertion(requestOptions, { conditional: false, signal })
    ).resolves.toEqual({
      id: "credential-id",
      rawId: "AQID",
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        authenticatorData: "BA",
        clientDataJSON: "BQ",
        signature: "Bg",
        userHandle: "Bw",
      },
    });

    const { mediation, publicKey, signal: requestSignal } = requested();
    expect(mediation).toBeUndefined();
    expect(requestSignal).toBe(signal);
    expect(publicKey.rpId).toBe("workspace.invalid");
    expect(toBytes(publicKey.challenge)).toEqual(new Uint8Array([1, 2, 3]));
    const [allowed] = publicKey.allowCredentials ?? [];
    expect(toBytes(allowed?.id)).toEqual(new Uint8Array([4, 5]));
    expect(allowed?.transports).toEqual(["internal"]);
  });

  test("offers every passkey in a conditional request", async () => {
    await getPasskeyAssertion(requestOptions, {
      conditional: true,
      signal: new AbortController().signal,
    });

    expect(requested().mediation).toBe("conditional");
    expect(requested().publicKey.allowCredentials).toEqual([]);
  });

  test("leaves an empty allow list out of a modal request", async () => {
    await getPasskeyAssertion(
      { ...requestOptions, allowCredentials: [] },
      { conditional: false, signal: new AbortController().signal }
    );

    expect(requested().publicKey.allowCredentials).toBeUndefined();
  });

  test("passes the browser's error on and rejects a missing credential", async () => {
    const dismissed = new DOMException("Dismissed", "NotAllowedError");
    get.mockRejectedValueOnce(dismissed);
    const request = () =>
      getPasskeyAssertion(requestOptions, {
        conditional: false,
        signal: new AbortController().signal,
      });

    await expect(request()).rejects.toBe(dismissed);
    get.mockResolvedValueOnce(null);
    await expect(request()).rejects.toThrow("No passkey was picked.");
  });

  test("rejects a credential that isn't a passkey assertion", async () => {
    const request = () =>
      getPasskeyAssertion(requestOptions, {
        conditional: false,
        signal: new AbortController().signal,
      });

    get.mockResolvedValueOnce({ id: "password", type: "password" });
    await expect(request()).rejects.toThrow(Error);
    get.mockResolvedValueOnce(new TestPublicKeyCredential(null));
    await expect(request()).rejects.toThrow(Error);
  });

  test("passes on every transport the passkey recorded", async () => {
    await getPasskeyAssertion(
      {
        ...requestOptions,
        allowCredentials: [
          {
            id: "BAU",
            type: "public-key",
            transports: ["usb", "smart-card", "hybrid"],
          },
        ],
      },
      { conditional: false, signal: new AbortController().signal }
    );

    const [allowed] = requested().publicKey.allowCredentials ?? [];
    expect(allowed?.transports).toEqual(["usb", "smart-card", "hybrid"]);
  });
});
