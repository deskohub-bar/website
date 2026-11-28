import { describe, expect, mock, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";
import { IgloohomeRuntimeConfig } from "../config";
import { IgloohomeRequestError } from "../errors";
import { IgloohomeClientError } from "../generated/effect.gen";
import type { IssueHourlyAlgoPinInput } from "../types";
import { IgloohomeDeviceIdSchema } from "../types";
import { IgloohomeAccessToken, mapAlgoPinRequestError } from "./api";
import { IgloohomeService } from "./service";

const getRequest = (input: RequestInfo | URL, init?: RequestInit) =>
  input instanceof Request ? input : new Request(input, init);

const mockFetch = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof globalThis.fetch =>
  Object.assign(mock(handler), { preconnect: globalThis.fetch.preconnect });

describe("mapAlgoPinRequestError", () => {
  const algoPinRequest = HttpClientRequest.post(
    "https://api.example.test/igloohome/devices/EK1X16f8898a/algopin/hourly"
  );
  const providerResponse = (status: number, body: string | null = null) =>
    HttpClientResponse.fromWeb(algoPinRequest, new Response(body, { status }));
  const undocumentedStatusFailure = (status: number) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({
        request: algoPinRequest,
        response: providerResponse(status),
      }),
    });

  test("only treats documented precondition responses as definitive rejection", () => {
    const rejections = [
      IgloohomeClientError("CreateHourlyAlgoPin400", {}, providerResponse(400)),
      IgloohomeClientError("CreateHourlyAlgoPin401", {}, providerResponse(401)),
      IgloohomeClientError("CreateHourlyAlgoPin403", {}, providerResponse(403)),
      IgloohomeClientError("CreateHourlyAlgoPin404", {}, providerResponse(404)),
      IgloohomeClientError("CreateHourlyAlgoPin415", {}, providerResponse(415)),
    ];
    for (const failure of rejections) {
      expect(mapAlgoPinRequestError(failure).outcome).toBe("rejected");
    }

    const ambiguousFailures = [
      IgloohomeClientError("CreateHourlyAlgoPin500", {}, providerResponse(500)),
      ...[408, 425, 429, 499, 503].map(undocumentedStatusFailure),
    ];
    for (const failure of ambiguousFailures) {
      expect(mapAlgoPinRequestError(failure).outcome).toBe("ambiguous");
    }
  });

  test("does not retain a provider response payload in the public error", () => {
    const error = mapAlgoPinRequestError(
      IgloohomeClientError(
        "CreateHourlyAlgoPin500",
        { error: "987654321" },
        providerResponse(500, JSON.stringify({ pin: "987654321" }))
      )
    );

    expect(error.statusCode).toBe(500);
    expect(JSON.stringify(error)).not.toContain("987654321");
  });
});

describe("IgloohomeService", () => {
  const recordRequests = (requests: Request[]) =>
    mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = getRequest(input, init);
      requests.push(request.clone());

      if (request.url === "https://auth.example.test/oauth2/token") {
        return Response.json({
          access_token: "access-token",
          expires_in: 3600,
        });
      }
      if (
        request.url ===
        "https://api.example.test/igloohome/devices/EK1X16f8898a/algopin/hourly"
      ) {
        return Response.json({ pin: "7654321", pinId: "pin-id" });
      }
      return new Response(null, { status: 404 });
    });

  const buildServiceLayer = (
    httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
    apiTimeout = 1_000
  ) =>
    IgloohomeService.Default.pipe(
      Layer.provide(IgloohomeAccessToken.Default),
      Layer.provide(
        Layer.merge(
          Layer.succeed(IgloohomeRuntimeConfig, {
            apiUrl: "https://api.example.test/igloohome",
            authUrl: "https://auth.example.test",
            clientId: "client-id",
            clientSecret: "client-secret",
            apiTimeout,
          }),
          httpClientLayer
        )
      )
    );

  const buildFetchServiceLayer = (
    fetchMock: typeof globalThis.fetch,
    apiTimeout?: number
  ) =>
    buildServiceLayer(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchMock))
      ),
      apiTimeout
    );

  const deviceId = Schema.decodeUnknownSync(IgloohomeDeviceIdSchema)(
    "EK1X16f8898a"
  );

  test("authenticates and issues an hourly AlgoPIN with the documented request", async () => {
    const requests: Request[] = [];
    const result = await Effect.gen(function* () {
      const service = yield* IgloohomeService;
      return yield* service.issueHourlyAlgoPin({
        deviceId,
        variance: 3,
        startsAt: "2026-08-13T09:00:00+02:00",
        endsAt: "2026-08-13T17:00:00+02:00",
        accessName: "Deskohub reservation-id",
      });
    }).pipe(
      Effect.provide(buildFetchServiceLayer(recordRequests(requests))),
      Effect.runPromise
    );

    expect(String(result.pin)).toBe("7654321");
    expect(String(result.pinId)).toBe("pin-id");
    expect(requests).toHaveLength(2);

    const [authRequest, issueRequest] = requests;
    if (authRequest === undefined || issueRequest === undefined) {
      throw new Error("Expected the authentication and AlgoPIN requests.");
    }
    expect(authRequest.method).toBe("POST");
    expect(authRequest.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
    );
    expect(
      Object.fromEntries(new URLSearchParams(await authRequest.text()))
    ).toEqual({
      grant_type: "client_credentials",
      scope: "igloohomeapi/algopin-hourly",
    });

    expect(issueRequest.method).toBe("POST");
    expect(issueRequest.headers.get("authorization")).toBe(
      "Bearer access-token"
    );
    expect(await issueRequest.json()).toEqual({
      variance: 3,
      startDate: "2026-08-13T09:00:00+02:00",
      endDate: "2026-08-13T17:00:00+02:00",
      accessName: "Deskohub reservation-id",
    });
  });

  test("re-authenticates after the provider rejects a cached access token", async () => {
    let issuedTokens = 0;
    const fetchMock = mockFetch(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = getRequest(input, init);
        if (request.url === "https://auth.example.test/oauth2/token") {
          issuedTokens += 1;
          return Response.json({
            access_token: `access-token-${issuedTokens}`,
            expires_in: 3600,
          });
        }
        return request.headers.get("authorization") === "Bearer access-token-1"
          ? new Response(null, { status: 401 })
          : Response.json({ pin: "7654321", pinId: "pin-id" });
      }
    );
    const input = {
      deviceId,
      variance: 1,
      startsAt: "2026-08-13T09:00:00+02:00",
      endsAt: "2026-08-13T17:00:00+02:00",
      accessName: "Deskohub reservation-id",
    } satisfies IssueHourlyAlgoPinInput;

    const [revoked, renewed] = await Effect.gen(function* () {
      const service = yield* IgloohomeService;
      const revoked = yield* service
        .issueHourlyAlgoPin(input)
        .pipe(Effect.flip);
      const renewed = yield* service.issueHourlyAlgoPin(input);
      return [revoked, renewed] as const;
    }).pipe(
      Effect.provide(buildFetchServiceLayer(fetchMock)),
      Effect.runPromise
    );

    expect(revoked).toMatchObject({
      operation: "issue_hourly_algopin",
      outcome: "rejected",
      statusCode: 401,
    });
    expect(String(renewed.pin)).toBe("7654321");
    expect(issuedTokens).toBe(2);
  });

  test("interrupts a delayed authentication before any AlgoPIN request can follow", async () => {
    const requests: Request[] = [];
    const abortSignals: AbortSignal[] = [];
    let completeAuthentication: ((response: Response) => void) | undefined;
    const fetchMock = mockFetch(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = getRequest(input, init);
        requests.push(request.clone());
        abortSignals.push(request.signal);
        if (request.url === "https://auth.example.test/oauth2/token") {
          return await new Promise<Response>((resolve) => {
            completeAuthentication = resolve;
          });
        }
        return Response.json({ pin: "7654321", pinId: "pin-id" });
      }
    );

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* IgloohomeService;
        return yield* service.issueHourlyAlgoPin({
          deviceId,
          variance: 1,
          startsAt: "2026-08-13T09:00:00+02:00",
          endsAt: "2026-08-13T17:00:00+02:00",
          accessName: "Deskohub reservation-id",
        });
      }).pipe(Effect.provide(buildFetchServiceLayer(fetchMock, 40)))
    );

    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(failure).toBeInstanceOf(IgloohomeRequestError);
    expect(failure?.operation).toBe("authenticate");
    expect(failure?.outcome).toBe("rejected");

    completeAuthentication?.(
      Response.json({ access_token: "late-token", expires_in: 3600 })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requests).toHaveLength(1);
    expect(abortSignals[0]?.aborted).toBe(true);
  });

  test("aborts a stalled authentication body and blocks any later AlgoPIN request", async () => {
    const requests: Request[] = [];
    let completeBody: (() => void) | undefined;
    let bodyCancelled = false;
    const fetchMock = mockFetch(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = getRequest(input, init);
        requests.push(request.clone());
        if (request.url === "https://auth.example.test/oauth2/token") {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"access_'));
              completeBody = () => {
                if (bodyCancelled) return;
                controller.enqueue(encoder.encode('token":"late-token"}'));
                controller.close();
              };
            },
            cancel: () => {
              bodyCancelled = true;
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return Response.json({ pin: "7654321", pinId: "pin-id" });
      }
    );

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* IgloohomeService;
        return yield* service.issueHourlyAlgoPin({
          deviceId,
          variance: 1,
          startsAt: "2026-08-13T09:00:00+02:00",
          endsAt: "2026-08-13T17:00:00+02:00",
          accessName: "Deskohub reservation-id",
        });
      }).pipe(Effect.provide(buildFetchServiceLayer(fetchMock, 40)))
    );

    const failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(failure).toBeInstanceOf(IgloohomeRequestError);
    expect(failure?.operation).toBe("authenticate");
    expect(failure?.outcome).toBe("rejected");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodyCancelled).toBe(true);

    completeBody?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requests).toHaveLength(1);
  });

  test("gives authentication and creation separate request timeouts", async () => {
    const httpClient = HttpClient.make((request, url) =>
      Effect.sleep("150 millis").pipe(
        Effect.map(() =>
          HttpClientResponse.fromWeb(
            request,
            url.pathname === "/oauth2/token"
              ? Response.json({
                  access_token: "access-token",
                  expires_in: 3600,
                })
              : Response.json({ pin: "7654321", pinId: "pin-id" })
          )
        )
      )
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* IgloohomeService;
        const issuePin = yield* service
          .issueHourlyAlgoPin({
            deviceId,
            variance: 1,
            startsAt: "2026-08-13T09:00:00+02:00",
            endsAt: "2026-08-13T17:00:00+02:00",
            accessName: "Deskohub reservation-id",
          })
          .pipe(Effect.forkChild);
        // Both requests fit within 200 ms each and take longer together.
        yield* TestClock.adjust("400 millis");
        expect(issuePin.pollUnsafe()).toBeDefined();
        return yield* Fiber.join(issuePin);
      }).pipe(
        Effect.provide(
          Layer.merge(
            buildServiceLayer(
              Layer.succeed(HttpClient.HttpClient, httpClient),
              200
            ),
            TestClock.layer()
          )
        )
      )
    );

    expect(String(result.pin)).toBe("7654321");
  });
});
