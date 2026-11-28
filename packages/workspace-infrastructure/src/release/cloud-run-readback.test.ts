import { describe, expect, test } from "bun:test";
import { Credentials } from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { ImageDigest } from "../config/stack-config";
import { sandboxConfig } from "../config/stack-config.test-utils";
import { refusedCredentials } from "../google-credentials.test-utils";
import { trafficReadback } from "../readback";
import {
  templateSpecAnnotation,
  trafficGenerationAnnotation,
} from "../resources/service-declarations";
import { cloudRunServiceReadbackLayer } from "./cloud-run-readback";
import {
  type ReleaseReadbackUnavailable,
  ReleaseServiceReadback,
} from "./release-platform";

const servingDigest = ImageDigest.make(`sha256:${"1".repeat(64)}`);
const candidateDigest = ImageDigest.make(`sha256:${"2".repeat(64)}`);
const servingRevision = "workspace-api-r4-aaaaaaa";
const candidateRevision = "workspace-api-r5-bbbbbbb";
// Synthetic; the fake only checks that it is sent as the bearer token.
const accessToken = "synthetic-access-token";

const servicesPath = `/v2/projects/${sandboxConfig.projectId}/locations/${sandboxConfig.region}/services`;
const apiPath = `${servicesPath}/workspace-api`;
const revisionPath = (revision: string) => `${apiPath}/revisions/${revision}`;
const imageReference = (digest: string) =>
  `${sandboxConfig.region}-docker.pkg.dev/${sandboxConfig.projectId}/workspace/workspace@${digest}`;

/** A Ready revision whose one container resolved to `digest`. */
const readyRevision = (revision: string, digest: string) => ({
  name: `projects/${sandboxConfig.projectId}/locations/${sandboxConfig.region}/services/workspace-api/revisions/${revision}`,
  containers: [{ name: "workspace", image: imageReference(digest) }],
  containerStatuses: [
    { name: "workspace", imageDigest: imageReference(digest) },
  ],
  conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }],
});

/**
 * The API service fully on one digest-pinned revision with a zero-percent
 * tagged candidate. Proto3 JSON omits the candidate's zero percent.
 */
const steadyApi = {
  name: `projects/${sandboxConfig.projectId}/locations/${sandboxConfig.region}/services/workspace-api`,
  uri: "https://workspace-api-abc123-ew.a.run.app",
  urls: [
    "https://workspace-api-123456789012.europe-west1.run.app",
    "https://workspace-api-abc123-ew.a.run.app",
  ],
  ingress: "INGRESS_TRAFFIC_ALL",
  invokerIamDisabled: false,
  terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" },
  trafficStatuses: [
    {
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: servingRevision,
      percent: 100,
    },
    {
      type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
      revision: candidateRevision,
      tag: "candidate",
    },
  ],
  annotations: { [trafficGenerationAnnotation]: "7" },
};

type Answer =
  | {
      readonly status: number;
      readonly body?: unknown;
      /** A raw body instead of JSON-encoded `body`. */
      readonly text?: string;
      /** The body starts but never finishes. */
      readonly stallBody?: true;
    }
  /** No response: the connection failed, or headers never arrive. */
  | { readonly transport: "failed" | "stalled" };

/**
 * An in-memory Cloud Run Admin API. Each path answers its listed responses
 * in order and repeats the last; unknown paths answer 404 like Cloud Run.
 */
const fakeCloudRun = (
  routes: Record<string, Answer | ReadonlyArray<Answer>>
) => {
  const queues = new Map(
    Object.entries(routes).map(([path, answers]) => [
      path,
      Array.isArray(answers) ? [...answers] : [answers],
    ])
  );
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
    readonly quotaProject: string | undefined;
    readonly origin: string;
    readonly signal: AbortSignal;
  }> = [];
  const client = HttpClient.make((request, url, signal) => {
    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization,
      quotaProject: request.headers["x-goog-user-project"],
      origin: url.origin,
      signal,
    });
    const queue = queues.get(url.pathname);
    const answer: Answer = (queue && queue.length > 1
      ? queue.shift()
      : queue?.[0]) ?? {
      status: 404,
      body: { error: { code: 404, status: "NOT_FOUND" } },
    };
    if ("transport" in answer) {
      return answer.transport === "stalled"
        ? Effect.never
        : Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          );
    }
    const body = answer.stallBody
      ? new ReadableStream({
          start: (controller) => controller.enqueue(new Uint8Array([123])),
        })
      : (answer.text ?? JSON.stringify(answer.body ?? {}));
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        })
      )
    );
  });
  return { client, requests };
};

/** The live readback over the fake, with a test clock that tests advance. */
const readbackLayer = (
  fake: ReturnType<typeof fakeCloudRun>,
  credentials: typeof Credentials.Service = Effect.succeed({
    accessToken: Redacted.make(accessToken),
  })
) =>
  Layer.mergeAll(
    cloudRunServiceReadbackLayer(sandboxConfig).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, fake.client),
          Layer.succeed(Credentials, credentials)
        )
      )
    ),
    TestClock.layer()
  );

/** Run one readback against the fake, skipping every timeout and backoff. */
const readback = <A>(
  fake: ReturnType<typeof fakeCloudRun>,
  use: (
    port: typeof ReleaseServiceReadback.Service
  ) => Effect.Effect<A, ReleaseReadbackUnavailable>,
  credentials?: typeof Credentials.Service
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          return yield* use(yield* ReleaseServiceReadback);
        })
      );
      yield* TestClock.adjust("10 minutes");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(readbackLayer(fake, credentials)))
  );

const success = async <A>(
  exit: Promise<Exit.Exit<A, ReleaseReadbackUnavailable>>
) => {
  const settled = await exit;
  if (Exit.isFailure(settled)) {
    throw new Error(`expected a success, got ${String(settled.cause)}`);
  }
  return settled.value;
};

const failure = async <A>(
  exit: Promise<Exit.Exit<A, ReleaseReadbackUnavailable>>
) => {
  const settled = await exit;
  if (Exit.isSuccess(settled)) {
    throw new Error("expected a failure");
  }
  const reason = settled.cause.reasons[0];
  return reason?._tag === "Fail" ? reason.error : reason;
};

const steadyApiAnswer = { status: 200, body: steadyApi };
const steadyRoutes = {
  [apiPath]: steadyApiAnswer,
  [revisionPath(servingRevision)]: {
    status: 200,
    body: readyRevision(servingRevision, servingDigest),
  },
  [revisionPath(candidateRevision)]: {
    status: 200,
    body: readyRevision(candidateRevision, candidateDigest),
  },
};

describe("Cloud Run service readback", () => {
  test("reads a steady service and the digests of its routed revisions", async () => {
    const fake = fakeCloudRun(steadyRoutes);
    const observed = await success(
      readback(fake, (port) => port.service("api"))
    );
    expect(observed).toEqual({
      workload: "api",
      uri: steadyApi.uri,
      urls: steadyApi.urls,
      ingress: "INGRESS_TRAFFIC_ALL",
      invokerIamDisabled: false,
      terminalConditionState: "CONDITION_SUCCEEDED",
      reconciling: false,
      traffic: [
        { revision: servingRevision, percent: 100 },
        { revision: candidateRevision, percent: 0, tag: "candidate" },
      ],
      revisionDigests: {
        [servingRevision]: servingDigest,
        [candidateRevision]: candidateDigest,
      },
      annotations: { [trafficGenerationAnnotation]: "7" },
    });
    expect(observed && trafficReadback(observed)).toEqual({
      servingRevision,
      servingImageDigest: servingDigest,
      trafficGeneration: 7,
    });
  });

  test("reads each resource at its exact path with the bearer token", async () => {
    const fake = fakeCloudRun(steadyRoutes);
    await success(readback(fake, (port) => port.service("api")));
    expect(fake.requests.map(({ path }) => path).toSorted()).toEqual(
      [
        apiPath,
        revisionPath(candidateRevision),
        revisionPath(servingRevision),
      ].toSorted()
    );
    for (const request of fake.requests) {
      expect(request.method).toBe("GET");
      expect(request.origin).toBe("https://run.googleapis.com");
      expect(request.authorization).toBe(`Bearer ${accessToken}`);
      expect(request.quotaProject).toBeUndefined();
    }
  });

  test("bills user credentials to their quota project", async () => {
    const fake = fakeCloudRun(steadyRoutes);
    await success(
      readback(
        fake,
        (port) => port.revision(servingRevision),
        Effect.succeed({
          accessToken: Redacted.make(accessToken),
          quotaProject: "quota-project",
        })
      )
    );
    await success(
      readback(
        fake,
        (port) => port.revision(servingRevision),
        Effect.succeed({
          accessToken: Redacted.make(accessToken),
          quotaProject: "",
        })
      )
    );
    expect(fake.requests.map(({ quotaProject }) => quotaProject)).toEqual([
      "quota-project",
      undefined,
    ]);
  });

  test("reads worker services under their own service ids", async () => {
    const fake = fakeCloudRun({
      [`${servicesPath}/workspace-tasks-worker`]: {
        status: 200,
        body: { ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" },
      },
    });
    const observed = await success(
      readback(fake, (port) => port.service("tasks-worker"))
    );
    expect(observed).toMatchObject({
      workload: "tasks-worker",
      ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
      invokerIamDisabled: false,
      urls: [],
      traffic: [],
      revisionDigests: {},
      annotations: {},
    });
  });

  test("a missing service or revision is null", async () => {
    const fake = fakeCloudRun({});
    expect(
      await success(readback(fake, (port) => port.service("api")))
    ).toBeNull();
    expect(
      await success(readback(fake, (port) => port.revision(servingRevision)))
    ).toBeNull();
  });

  test("a routed revision that vanished leaves no digest", async () => {
    const fake = fakeCloudRun({ [apiPath]: steadyApiAnswer });
    const observed = await success(
      readback(fake, (port) => port.service("api"))
    );
    expect(observed?.revisionDigests).toEqual({});
    expect(observed && trafficReadback(observed).servingImageDigest).toBeNull();
  });

  test("split traffic has no single serving revision", async () => {
    const fake = fakeCloudRun({
      ...steadyRoutes,
      [apiPath]: {
        status: 200,
        body: {
          ...steadyApi,
          trafficStatuses: [
            { revision: servingRevision, percent: 50 },
            { revision: candidateRevision, percent: 50 },
          ],
        },
      },
    });
    const observed = await success(
      readback(fake, (port) => port.service("api"))
    );
    expect(observed?.revisionDigests).toEqual({
      [servingRevision]: servingDigest,
      [candidateRevision]: candidateDigest,
    });
    expect(observed && trafficReadback(observed)).toMatchObject({
      servingRevision: null,
      servingImageDigest: null,
    });
  });

  test("a LATEST row that names no revision never passes as one", async () => {
    const fake = fakeCloudRun({
      [apiPath]: {
        status: 200,
        body: {
          ...steadyApi,
          trafficStatuses: [
            { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 },
          ],
        },
      },
    });
    const observed = await success(
      readback(fake, (port) => port.service("api"))
    );
    expect(observed?.traffic).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(observed && trafficReadback(observed).servingRevision).toBeNull();
  });

  test("reconciling or failed services have no serving revision", async () => {
    for (const status of [
      { reconciling: true },
      { terminalCondition: { type: "Ready", state: "CONDITION_FAILED" } },
    ]) {
      const fake = fakeCloudRun({
        ...steadyRoutes,
        [apiPath]: { status: 200, body: { ...steadyApi, ...status } },
      });
      const observed = await success(
        readback(fake, (port) => port.service("api"))
      );
      expect(observed && trafficReadback(observed).servingRevision).toBeNull();
    }
  });

  test("reads a Ready revision and its resolved digest", async () => {
    const fake = fakeCloudRun(steadyRoutes);
    expect(
      await success(readback(fake, (port) => port.revision(candidateRevision)))
    ).toEqual({
      revision: candidateRevision,
      imageDigest: candidateDigest,
      ready: true,
    });
    expect(fake.requests.map(({ path }) => path)).toEqual([
      revisionPath(candidateRevision),
    ]);
  });

  test("a reconciling or failed revision is not ready", async () => {
    for (const status of [
      { reconciling: true },
      { conditions: [{ type: "Ready", state: "CONDITION_FAILED" }] },
      { conditions: [] },
    ]) {
      const fake = fakeCloudRun({
        [revisionPath(candidateRevision)]: {
          status: 200,
          body: {
            ...readyRevision(candidateRevision, candidateDigest),
            ...status,
          },
        },
      });
      expect(
        await success(
          readback(fake, (port) => port.revision(candidateRevision))
        )
      ).toMatchObject({ ready: false, imageDigest: candidateDigest });
    }
  });

  test("a revision without a resolved sha256 digest has none", async () => {
    for (const containerStatuses of [
      [{ name: "workspace", imageDigest: "workspace:latest" }],
      [{ name: "workspace", imageDigest: "sha256:not-a-digest" }],
      [],
    ]) {
      const fake = fakeCloudRun({
        [revisionPath(candidateRevision)]: {
          status: 200,
          body: {
            ...readyRevision(candidateRevision, candidateDigest),
            containerStatuses,
          },
        },
      });
      expect(
        await success(
          readback(fake, (port) => port.revision(candidateRevision))
        )
      ).toMatchObject({ imageDigest: null });
    }
  });

  test("accepts a bare digest and picks the serving container's", async () => {
    const fake = fakeCloudRun({
      [revisionPath(candidateRevision)]: {
        status: 200,
        body: {
          ...readyRevision(candidateRevision, candidateDigest),
          containers: [
            { name: "sidecar" },
            { name: "workspace", ports: [{ containerPort: 8080 }] },
          ],
          containerStatuses: [
            { name: "sidecar", imageDigest: servingDigest },
            { name: "workspace", imageDigest: candidateDigest },
          ],
        },
      },
    });
    expect(
      await success(readback(fake, (port) => port.revision(candidateRevision)))
    ).toMatchObject({ imageDigest: candidateDigest });
  });

  test("never takes a sidecar's digest for the serving container", async () => {
    for (const shape of [
      {
        containers: [
          { name: "sidecar" },
          { name: "workspace", ports: [{ containerPort: 8080 }] },
        ],
        containerStatuses: [{ name: "sidecar", imageDigest: servingDigest }],
      },
      {
        containers: [{ name: "workspace" }],
        containerStatuses: [{ name: "sidecar", imageDigest: servingDigest }],
      },
      {
        containers: [{ name: "sidecar" }, { name: "workspace" }],
        containerStatuses: [{ name: "workspace", imageDigest: servingDigest }],
      },
    ]) {
      const fake = fakeCloudRun({
        [revisionPath(candidateRevision)]: {
          status: 200,
          body: {
            ...readyRevision(candidateRevision, candidateDigest),
            ...shape,
          },
        },
      });
      expect(
        await success(
          readback(fake, (port) => port.revision(candidateRevision))
        )
      ).toMatchObject({ imageDigest: null });
    }
  });

  test("a name Cloud Run could not assign is no revision and sends no request", async () => {
    const fake = fakeCloudRun(steadyRoutes);
    for (const name of ["../workspace-tasks-worker", "Workspace-api", ""]) {
      expect(
        await success(readback(fake, (port) => port.revision(name)))
      ).toBeNull();
    }
    expect(fake.requests).toHaveLength(0);
  });

  test("retries missing answers, rate limits and server errors, then reads", async () => {
    const fake = fakeCloudRun({
      ...steadyRoutes,
      [apiPath]: [
        { status: 503 },
        { transport: "failed" },
        { status: 429 },
        { status: 200, stallBody: true },
        steadyApiAnswer,
      ],
    });
    const observed = await success(
      readback(fake, (port) => port.service("api"))
    );
    expect(observed?.workload).toBe("api");
    expect(fake.requests.filter(({ path }) => path === apiPath)).toHaveLength(
      5
    );
  });

  test("mixed transient failures share one retry budget", async () => {
    const fake = fakeCloudRun({
      [apiPath]: [
        { status: 500 },
        { transport: "stalled" },
        { status: 429 },
        { status: 200, stallBody: true },
        { transport: "failed" },
        { status: 501 },
      ],
    });
    const error = await failure(readback(fake, (port) => port.service("api")));
    expect(error).toMatchObject({
      _tag: "ReleaseReadbackUnavailable",
      resource: apiPath.replace("/v2/", ""),
      status: null,
    });
    // One attempt plus the four retries the read allows.
    expect(fake.requests).toHaveLength(5);
  });

  test("fails unavailable once the retries are spent", async () => {
    const fake = fakeCloudRun({ [apiPath]: { status: 501 } });
    const error = await failure(readback(fake, (port) => port.service("api")));
    expect(error).toMatchObject({
      _tag: "ReleaseReadbackUnavailable",
      resource: apiPath.replace("/v2/", ""),
      status: 501,
    });
    // One attempt plus the four retries the read allows.
    expect(fake.requests).toHaveLength(5);
  });

  test("refused or unreadable answers fail unavailable without retrying", async () => {
    for (const [answer, status] of [
      [{ status: 403, body: { error: { message: "secret-detail" } } }, 403],
      [{ status: 401 }, 401],
      [{ status: 400 }, 400],
      [{ status: 200, body: { trafficStatuses: "not-a-list" } }, 200],
      [{ status: 200, text: "{not json" }, 200],
    ] as const) {
      const fake = fakeCloudRun({ [apiPath]: answer });
      const error = await failure(
        readback(fake, (port) => port.service("api"))
      );
      expect(error).toMatchObject({
        _tag: "ReleaseReadbackUnavailable",
        status,
      });
      expect(JSON.stringify(error)).not.toContain("secret-detail");
      expect(JSON.stringify(error)).not.toContain(accessToken);
      expect(fake.requests).toHaveLength(1);
    }
  });

  test("credentials that fail or hang fail unavailable without a request", async () => {
    for (const credentials of [
      // Any failure of the credential lookup must surface the same way.
      refusedCredentials("no credentials"),
      Effect.never,
      Effect.die("token lookup crashed"),
    ]) {
      const fake = fakeCloudRun(steadyRoutes);
      const error = await failure(
        readback(fake, (port) => port.service("api"), credentials)
      );
      expect(error).toMatchObject({
        _tag: "ReleaseReadbackUnavailable",
        status: null,
        reason: "credentials unavailable",
      });
      expect(fake.requests).toHaveLength(0);
    }
  });

  test("a stalled credential lookup fails the read at ten seconds, looked up once", async () => {
    let lookups = 0;
    const fake = fakeCloudRun(steadyRoutes);
    const settled = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            return yield* (yield* ReleaseServiceReadback).service("api");
          })
        );
        yield* TestClock.adjust("9999 millis");
        const early = fiber.pollUnsafe();
        yield* TestClock.adjust("1 millis");
        return { early, late: fiber.pollUnsafe() };
      }).pipe(
        Effect.provide(
          readbackLayer(
            fake,
            Effect.suspend(() => {
              lookups += 1;
              return Effect.never;
            })
          )
        )
      )
    );
    expect(settled.early).toBeUndefined();
    expect(settled.late && Exit.isFailure(settled.late)).toBe(true);
    expect(lookups).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });

  test("times out each attempt at ten seconds and backs off from 250 ms", async () => {
    const fake = fakeCloudRun({
      ...steadyRoutes,
      [apiPath]: [{ transport: "stalled" }, steadyApiAnswer],
    });
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            return yield* (yield* ReleaseServiceReadback).service("api");
          })
        );
        const seen: Array<number> = [];
        for (const step of [
          "9999 millis",
          "1 millis",
          "249 millis",
          "1 millis",
        ] as const) {
          yield* TestClock.adjust(step);
          seen.push(
            fake.requests.filter(({ path }) => path === apiPath).length
          );
        }
        yield* Fiber.join(fiber);
        return seen;
      }).pipe(Effect.provide(readbackLayer(fake)))
    );
    expect(attempts).toEqual([1, 1, 1, 2]);
  });

  test("releases every attempt's request, bodies left unread included", async () => {
    const fake = fakeCloudRun({
      [apiPath]: [
        { status: 503, stallBody: true },
        { status: 503, stallBody: true },
        { status: 404, stallBody: true },
      ],
    });
    expect(
      await success(readback(fake, (port) => port.service("api")))
    ).toBeNull();
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.every(({ signal }) => signal.aborted)).toBe(true);
  });
});

describe("Cloud Run service template readback", () => {
  test("reports the revision the live template declares", async () => {
    const fake = fakeCloudRun({
      ...steadyRoutes,
      [apiPath]: {
        status: 200,
        body: { ...steadyApi, template: { revision: candidateRevision } },
      },
    });
    const observed = await success(
      readback(fake, (port) => port.service("api"))
    );
    expect(observed?.templateRevision).toBe(candidateRevision);
  });

  test("reports the digest the live template's image pins, never a tag", async () => {
    const pinned = ImageDigest.make(`sha256:${"9".repeat(64)}`);
    const read = (image: string) =>
      success(
        readback(
          fakeCloudRun({
            ...steadyRoutes,
            [apiPath]: {
              status: 200,
              body: {
                ...steadyApi,
                template: {
                  revision: candidateRevision,
                  containers: [{ image }],
                },
              },
            },
          }),
          (port) => port.service("api")
        )
      );
    const registry = "europe-west1-docker.pkg.dev/project/workspace/api";
    expect((await read(`${registry}@${pinned}`))?.templateImageDigest).toBe(
      pinned
    );
    expect(
      (await read(`${registry}:latest`))?.templateImageDigest
    ).toBeUndefined();
  });

  test("reads an unrouted template revision's readiness and spec fingerprint", async () => {
    const unrouted = "workspace-api-r3-aaaaaaa-t9";
    const read = (revisionAnswer: { status: number; body?: unknown }) =>
      success(
        readback(
          fakeCloudRun({
            ...steadyRoutes,
            [apiPath]: {
              status: 200,
              body: {
                ...steadyApi,
                template: {
                  revision: unrouted,
                  annotations: { [templateSpecAnnotation]: "0123456789abcdef" },
                },
              },
            },
            [revisionPath(unrouted)]: revisionAnswer,
          }),
          (port) => port.service("api")
        )
      );
    const ready = await read({
      status: 200,
      body: readyRevision(unrouted, servingDigest),
    });
    expect(ready).toMatchObject({
      templateRevision: unrouted,
      templateSpecFingerprint: "0123456789abcdef",
      templateReady: true,
    });
    // An unrouted revision never counts as serving.
    expect(Object.keys(ready?.revisionDigests ?? {})).not.toContain(unrouted);
    const failed = await read({
      status: 200,
      body: {
        ...readyRevision(unrouted, servingDigest),
        conditions: [{ type: "Ready", state: "CONDITION_FAILED" }],
      },
    });
    expect(failed?.templateReady).toBe(false);
  });
});
