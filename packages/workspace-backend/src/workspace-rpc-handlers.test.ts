import { expect, test } from "bun:test";
import { CampaignUnsubscribeTokenInvalid } from "@deskohub/workspace-domain/features/email-campaigns/campaign-token-errors";
import {
  CampaignUnsubscribeRejected,
  CampaignUnsubscribeToken,
  EmailPreferencesRpcs,
  layerCallerContextClient,
} from "@deskohub/workspace-rpc";
import { Effect, Layer, Option } from "effect";
import { RpcTest } from "effect/rpc";
import { CampaignUnsubscribeService } from "./features/email-campaigns/backend/campaign-unsubscribe.service";
import {
  CallerContextLive,
  WorkspaceRpcHandlers,
} from "./workspace-rpc-handlers";

const token = CampaignUnsubscribeToken.make(
  `${Buffer.from(JSON.stringify(["synthetic-send", "synthetic-customer"])).toString("base64url")}.${"A".repeat(43)}`
);
const rejected = CampaignUnsubscribeToken.make(
  `${Buffer.from(JSON.stringify(["synthetic-send", "missing-customer"])).toString("base64url")}.${"A".repeat(43)}`
);

test("serves the first email preferences slice through RpcTest", async () => {
  let withdrawn = false;
  const testService = Layer.succeed(CampaignUnsubscribeService, {
    sign: () => Effect.succeed(token),
    openPreferences: (input) =>
      input === token
        ? Effect.succeed("b".repeat(43))
        : Effect.fail(new CampaignUnsubscribeTokenInvalid()),
    unsubscribe: () =>
      Effect.sync(() => {
        if (withdrawn) return "unchanged";
        withdrawn = true;
        return "withdrawn";
      }),
  });
  const { grant, failure, first, second } = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(EmailPreferencesRpcs);
      const grant = yield* client["EmailPreferences.openPreferences"]({
        token,
      });
      const failure = yield* Effect.flip(
        client["EmailPreferences.openPreferences"]({ token: rejected })
      );
      const first = yield* client["EmailPreferences.unsubscribeOneClick"]({
        token,
      });
      const second = yield* client["EmailPreferences.unsubscribeOneClick"]({
        token,
      });
      return { grant, failure, first, second };
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          WorkspaceRpcHandlers.pipe(Layer.provide(testService)),
          CallerContextLive,
          layerCallerContextClient({
            correlationId: crypto.randomUUID(),
            locale: "cs-CZ",
            clientAddress: Option.none(),
            userAgent: Option.none(),
          })
        )
      )
    )
  );

  expect<string>(grant.accessToken).toBe("b".repeat(43));
  expect<string>(grant.accessToken).not.toBe(token);
  expect(failure).toBeInstanceOf(CampaignUnsubscribeRejected);
  expect(first).toBe("withdrawn");
  expect(second).toBe("unchanged");
});
