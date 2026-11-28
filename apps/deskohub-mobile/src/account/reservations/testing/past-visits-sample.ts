import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { CustomerApi } from "../../../customer-api/customer-api.service";
import { nativeCustomerApiTransport } from "../../../customer-api/platform-transports";
import {
  type FakeWorkspace,
  fakeWorkspaceHttpClient,
  fakeWorkspaceOrigin,
} from "../../../customer-api/testing/fake-workspace";

const dayMs = 24 * 60 * 60 * 1000;

/**
 * `count` past coworking visits of the account's own, one a day from
 * yesterday back, each its own confirmed order `sample-visit-<n>` paid with
 * money.
 */
export const samplePastVisits = (count: number, now: Date = new Date()) =>
  Array.from({ length: count }, (_, index) => {
    const day = new Date(now.getTime() - (index + 1) * dayMs);
    day.setUTCHours(7, 0, 0, 0);
    return {
      id: `sample-visit-${index + 1}`,
      orderId: `sample-visit-${index + 1}`,
      product: {
        kind: "cowork",
        tier: index % 2 === 0 ? "reserved-desk" : "open-space",
      },
      startsAt: day.toISOString(),
      endsAt: new Date(day.getTime() + 9 * 60 * 60 * 1000).toISOString(),
      seats: 1,
      status: "confirmed",
      settlement: "paid",
    };
  });

/**
 * The customer API over `workspace`, except that it lists nothing current
 * and `past` as the past reservations, and answers the pass reads as an
 * open pass rollout with no pass held.
 */
export const pastVisitsApiLayer = ({
  workspace,
  past,
  current = [],
}: {
  readonly workspace: FakeWorkspace;
  readonly past: ReadonlyArray<unknown>;
  readonly current?: ReadonlyArray<unknown>;
}): Layer.Layer<CustomerApi> => {
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(Effect.service(HttpClient.HttpClient), (fallback) =>
      HttpClient.make((request, url) => {
        const respond = (body: unknown) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json(body))
          );
        switch (url.pathname.replace(/\/$/, "")) {
          case "/api/customer/reservations":
            return respond({ current, past, unavailable: [] });
          case "/api/customer/passes/catalog":
            return respond({
              entryPacks: [],
              unlimited: [],
              unlimitedCoffeePrice: { currency: "CZK", value: 0, exponent: 2 },
            });
          case "/api/customer/passes":
            return respond({ held: [], boughtForOthers: [] });
          default:
            return fallback.execute(request);
        }
      })
    )
  ).pipe(Layer.provide(fakeWorkspaceHttpClient(workspace)));
  return Layer.fresh(CustomerApi.Default).pipe(
    Layer.provide(
      nativeCustomerApiTransport({
        apiOrigin: fakeWorkspaceOrigin,
        readSessionCookie: Effect.succeed(""),
      })
    ),
    Layer.provide(transport)
  );
};
