import { randomUUID } from "node:crypto";
import { SandboxEmailPreferencesRpcs } from "@deskohub/workspace-cloud-run/sandbox-probe/email-preferences";
import {
  CampaignUnsubscribeToken,
  layerCallerContextClient,
  layerWorkspaceRpcProtocol,
  makeWorkspaceRpcClient,
} from "@deskohub/workspace-rpc";
import { Effect, Layer, Option, Redacted, Result } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient } from "effect/rpc";
import type { ProbeTarget } from "./probe-client";

interface EmailPreferencesProof {
  readonly opened: true;
  readonly rejected: "CampaignUnsubscribeRejected";
  readonly first: "withdrawn";
  readonly repeat: "unchanged";
}

const verifyEmailPreferences = Effect.fnUntraced(function* (marker: string) {
  const fixture = yield* RpcClient.make(SandboxEmailPreferencesRpcs, {
    disableTracing: true,
  });
  const client = yield* makeWorkspaceRpcClient();
  const token = yield* fixture["Probe.issueUnsubscribeToken"]({}).pipe(
    Effect.mapError((error) => `synthetic fixture: ${error._tag}`)
  );

  const grant = yield* client
    .openPreferences({ token })
    .pipe(Effect.mapError((error) => `open preferences: ${error._tag}`));
  const nextGrant = yield* client
    .openPreferences({ token })
    .pipe(Effect.mapError((error) => `reopen preferences: ${error._tag}`));
  if (
    String(grant.accessToken) === token ||
    String(nextGrant.accessToken) === token ||
    grant.accessToken === nextGrant.accessToken
  ) {
    return yield* Effect.fail("open preferences: the grant was not fresh");
  }

  // A token-shaped value with a false signature exercises the domain's
  // rejection. It also carries the privacy marker in the business RPC body.
  const invalidToken = CampaignUnsubscribeToken.make(
    `${marker}.${"A".repeat(43)}`
  );
  const rejected = yield* client
    .openPreferences({ token: invalidToken })
    .pipe(Effect.result);
  if (
    !Result.isFailure(rejected) ||
    rejected.failure._tag !== "CampaignUnsubscribeRejected"
  ) {
    return yield* Effect.fail("open preferences: expected typed rejection");
  }

  const first = yield* client
    .unsubscribeOneClick({ token })
    .pipe(Effect.mapError((error) => `unsubscribe: ${error._tag}`));
  if (first !== "withdrawn") {
    return yield* Effect.fail("unsubscribe: expected withdrawn");
  }
  const repeat = yield* client
    .unsubscribeOneClick({ token })
    .pipe(Effect.mapError((error) => `repeat unsubscribe: ${error._tag}`));
  if (repeat !== "unchanged") {
    return yield* Effect.fail("repeat unsubscribe: expected unchanged");
  }

  const proof: EmailPreferencesProof = {
    opened: true,
    rejected: rejected.failure._tag,
    first,
    repeat,
  };
  return proof;
});

/** Returns only fixed evidence fields and fixed step failures. */
export const runEmailPreferencesProbe = Effect.fnUntraced(function* (
  target: ProbeTarget
) {
  const caller = layerCallerContextClient({
    correlationId: randomUUID(),
    locale: "en-US",
    clientAddress: Option.none(),
    userAgent: Option.none(),
  });
  const protocol = layerWorkspaceRpcProtocol({
    url: target.url,
    authorization: Effect.succeed(Redacted.make(target.idToken)),
    invalidateAuthorization: () => Effect.void,
  }).pipe(
    Layer.provide(
      Layer.effect(HttpClient.HttpClient)(
        HttpClient.HttpClient.pipe(
          Effect.map(
            HttpClient.mapRequest(
              HttpClientRequest.setHeader("traceparent", target.traceparent)
            )
          )
        )
      )
    )
  );
  return yield* verifyEmailPreferences(target.marker).pipe(
    Effect.provide(Layer.merge(caller, protocol)),
    Effect.scoped,
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.catchDefect(() => Effect.fail("email preferences: defect")),
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.fail("email preferences: timeout"),
    }),
    Effect.result
  );
});
