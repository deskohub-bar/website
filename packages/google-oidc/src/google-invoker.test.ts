import { expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect } from "effect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  authenticateGoogleInvoker,
  GoogleIdentityKeys,
} from "./google-invoker";

const invoker = {
  email: testEmailAddress("tasks"),
  audience: "https://tasks-worker.workspace.test",
};
const signer = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [await exportJWK(signer.publicKey)] });

const tokenFor = (privateKey: CryptoKey) =>
  new SignJWT({ email: invoker.email, email_verified: true })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://accounts.google.com")
    .setAudience(invoker.audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

const authenticate = (authorization: string) =>
  authenticateGoogleInvoker(
    new Request("https://tasks-worker.workspace.test/", {
      headers: { authorization },
    }),
    invoker
  ).pipe(
    Effect.provideService(GoogleIdentityKeys, keys),
    Effect.match({
      onFailure: ({ status, reason }) => ({ status, reason }),
      onSuccess: () => "authenticated" as const,
    }),
    Effect.runPromise
  );

test("verifies with the injected key set", async () => {
  expect(
    await authenticate(`Bearer ${await tokenFor(signer.privateKey)}`)
  ).toBe("authenticated");
});

test("rejects a token the injected keys don't verify", async () => {
  const foreignSigner = await generateKeyPair("RS256");
  expect(
    await authenticate(`Bearer ${await tokenFor(foreignSigner.privateKey)}`)
  ).toEqual({ status: 401, reason: "invalid-token" });
});
