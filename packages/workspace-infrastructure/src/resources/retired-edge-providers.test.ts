import { describe, expect, test } from "bun:test";
import { Credentials } from "@alchemy.run/gcp";
import { alchemyLabelKeys } from "@alchemy.run/gcp/Labels";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import * as Apply from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { tryFindProviderByType } from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State/InMemoryState";
import type { ResourceState } from "alchemy/State/ResourceState";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import workspaceStack from "../../alchemy.run";
import { ImageDigest } from "../config/stack-config";
import { sandboxConfig } from "../config/stack-config.test-utils";
import { workersServing } from "../release/release-readback.test-utils";
import { promote, settleApply, stage } from "../release/release-reconciler";
import {
  emptyReleaseRecord,
  GitSha,
  type ReleaseRecord,
} from "../release/release-record";
import {
  makeInMemoryReleaseRecordStore,
  ReleaseRecordStore,
} from "../release/release-record-store";
import { requireStackWriter } from "../release/release-writer";
import { heldBy, testWriterToken } from "../release/release-writer.test-utils";
import { retiredEdgeProviders } from "./retired-edge-providers";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
}

type FakeResponse = {
  readonly status: number;
  readonly body?: unknown;
};

const now = DateTime.makeUnsafe("2026-11-22T10:00:00Z");
const digest = ImageDigest.make(`sha256:${"1".repeat(64)}`);

/** A pre-rename release record whose active revision still names workspace-web. */
const preRenameRecord = (): ReleaseRecord => {
  const staged = Effect.runSync(
    stage(emptyReleaseRecord, {
      expectedGeneration: 0,
      sha: GitSha.make("a".repeat(40)),
      imageDigest: digest,
      origin: "cloud-run",
      liveTemplate: null,
      now,
    })
  );
  const pending = Effect.runSync(
    promote(staged.record, {
      expectedGeneration: 1,
      releaseId: staged.releaseId,
      now,
      candidateReadback: null,
    })
  );
  const settled = Effect.runSync(
    settleApply(pending, {
      expectedGeneration: 2,
      readback: {
        servingRevision: "workspace-api-r1-aaaaaaa",
        servingImageDigest: digest,
        trafficGeneration: 1,
      },
      workers: workersServing(digest),
      now,
    })
  );
  if (settled.active === null) {
    throw new Error("expected an active release");
  }
  return {
    ...settled,
    active: { ...settled.active, revision: "workspace-web-r1-aaaaaaa" },
  };
};

const fakeCredentials = Layer.succeed(
  Credentials,
  Effect.succeed({
    accessToken: Redacted.make("test-access-token"),
    projectId: sandboxConfig.projectId,
  })
);

const alchemyTestPlatform = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  layerNonInteractive(),
  Layer.provide(AlchemyContextLive, PlatformServices),
  Layer.provide(AuthProvidersLive, PlatformServices),
  Layer.provide(ProfileStoreLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices)
);

const fakeHttpClient = (
  handler: (request: HttpClientRequest.HttpClientRequest) => FakeResponse
) => {
  const calls: RecordedRequest[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      calls.push({
        method: request.method,
        url: url.toString(),
      });
      const answer = handler(request);
      const body = answer.body === undefined ? "" : JSON.stringify(answer.body);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status: answer.status,
            headers: { "content-type": "application/json" },
          })
        )
      );
    })
  );
  return { calls, layer };
};

const ownedDescriptionFor = (logicalId: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=deskohubworkspace ${alchemyLabelKeys.stage}=sandbox ${alchemyLabelKeys.id}=${logicalId.toLowerCase()}]\nManaged by Alchemy`;

const preRenameRows = (): Record<string, ResourceState> => ({
  EdgeSecurityPolicy: {
    resourceType: "DeskohubWorkspace.EdgeSecurityPolicy",
    namespace: undefined,
    fqn: "EdgeSecurityPolicy",
    logicalId: "EdgeSecurityPolicy",
    instanceId: "inst-policy",
    providerVersion: 0,
    status: "created",
    downstream: ["DynamicEdgeBackend", "StaticEdgeBackend"],
    bindings: [],
    props: {
      project: sandboxConfig.projectId,
      name: "workspace-sandbox-edge-policy",
    },
    attr: {
      project: sandboxConfig.projectId,
      name: "workspace-sandbox-edge-policy",
      id: "policy-id-1",
      selfLink: `https://www.googleapis.com/compute/v1/projects/${sandboxConfig.projectId}/global/securityPolicies/workspace-sandbox-edge-policy`,
    },
  },
  DynamicEdgeBackend: {
    resourceType: "DeskohubWorkspace.EdgeBackendService",
    namespace: undefined,
    fqn: "DynamicEdgeBackend",
    logicalId: "DynamicEdgeBackend",
    instanceId: "inst-dynamic",
    providerVersion: 0,
    status: "created",
    downstream: [],
    bindings: [],
    props: {
      project: sandboxConfig.projectId,
      name: "workspace-sandbox-dynamic-backend",
    },
    attr: {
      project: sandboxConfig.projectId,
      name: "workspace-sandbox-dynamic-backend",
      id: "backend-id-1",
      selfLink: `https://www.googleapis.com/compute/v1/projects/${sandboxConfig.projectId}/global/backendServices/workspace-sandbox-dynamic-backend`,
    },
  },
  StaticEdgeBackend: {
    resourceType: "DeskohubWorkspace.EdgeBackendService",
    namespace: undefined,
    fqn: "StaticEdgeBackend",
    logicalId: "StaticEdgeBackend",
    instanceId: "inst-static",
    providerVersion: 0,
    status: "created",
    downstream: [],
    bindings: [],
    props: {
      project: sandboxConfig.projectId,
      name: "workspace-sandbox-static-backend",
    },
    attr: {
      project: sandboxConfig.projectId,
      name: "workspace-sandbox-static-backend",
      id: "backend-id-2",
      selfLink: `https://www.googleapis.com/compute/v1/projects/${sandboxConfig.projectId}/global/backendServices/workspace-sandbox-static-backend`,
    },
  },
});

const runFencedDestroy = (options: {
  readonly rows: Record<string, ResourceState>;
  readonly writer: Option.Option<Redacted.Redacted<string>>;
  readonly record?: ReleaseRecord;
  readonly handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => FakeResponse;
}) => {
  const stateMap = {
    DeskohubWorkspace: {
      sandbox: { ...options.rows },
    },
  } satisfies Record<string, Record<string, Record<string, ResourceState>>>;
  const { calls, layer: httpLayer } = fakeHttpClient(options.handler);
  const record = options.record ?? heldBy(preRenameRecord(), "destroy");

  const effect = Effect.gen(function* () {
    const store = yield* makeInMemoryReleaseRecordStore(record);
    const fencedState = Layer.mergeAll(
      inMemoryState(stateMap),
      Layer.effectDiscard(
        requireStackWriter(sandboxConfig, options.writer).pipe(
          Effect.provideService(ReleaseRecordStore, store)
        )
      ).pipe(Layer.orDie)
    );
    const services = yield* Stack.build({
      name: "DeskohubWorkspace",
      providers: retiredEdgeProviders.pipe(
        Layer.provide(Layer.mergeAll(fakeCredentials, httpLayer))
      ),
      state: fencedState,
    });
    const plan = yield* Plan.destroy(Context.get(services, Stack.Stack)).pipe(
      Effect.provide(Layer.succeedContext(services))
    );
    return yield* Apply.apply(plan).pipe(
      Effect.provide(Layer.succeedContext(services))
    );
  }).pipe(
    provideFreshArtifactStore,
    Effect.scoped,
    Effect.provide(alchemyTestPlatform),
    Effect.provideService(Stage, "sandbox")
  );

  return Effect.runPromiseExit(effect).then((exit) => ({
    exit,
    calls,
    remainingRows: Object.keys(stateMap.DeskohubWorkspace?.sandbox ?? {}),
  }));
};

describe("retired edge deletion providers", () => {
  test("drains pre-rename EdgeBackendService and EdgeSecurityPolicy rows under the destroy lock in reverse dependency order", async () => {
    const operationsPolled = new Map<string, number>();
    const result = await runFencedDestroy({
      rows: preRenameRows(),
      writer: Option.some(testWriterToken),
      handler: (request) => {
        if (
          request.method === "GET" &&
          request.url.includes(
            "/backendServices/workspace-sandbox-dynamic-backend"
          )
        ) {
          return {
            status: 200,
            body: {
              id: "backend-id-1",
              name: "workspace-sandbox-dynamic-backend",
            },
          };
        }
        if (
          request.method === "GET" &&
          request.url.includes(
            "/backendServices/workspace-sandbox-static-backend"
          )
        ) {
          return {
            status: 200,
            body: {
              id: "backend-id-2",
              name: "workspace-sandbox-static-backend",
            },
          };
        }
        if (
          request.method === "GET" &&
          request.url.includes(
            "/securityPolicies/workspace-sandbox-edge-policy"
          )
        ) {
          return {
            status: 200,
            body: { id: "policy-id-1", name: "workspace-sandbox-edge-policy" },
          };
        }
        if (
          request.method === "DELETE" &&
          request.url.includes(
            "/backendServices/workspace-sandbox-dynamic-backend"
          )
        ) {
          return {
            status: 200,
            body: { name: "op-del-dynamic", status: "DONE" },
          };
        }
        if (
          request.method === "DELETE" &&
          request.url.includes(
            "/backendServices/workspace-sandbox-static-backend"
          )
        ) {
          return {
            status: 200,
            body: { name: "op-del-static", status: "RUNNING" },
          };
        }
        if (
          request.method === "GET" &&
          request.url.includes("/global/operations/op-del-static")
        ) {
          const count = (operationsPolled.get("op-del-static") ?? 0) + 1;
          operationsPolled.set("op-del-static", count);
          // A freshly accepted Compute global operation can briefly 404.
          if (count === 1) {
            return {
              status: 404,
              body: { error: { message: "operation not visible yet" } },
            };
          }
          return {
            status: 200,
            body: { name: "op-del-static", status: "DONE" },
          };
        }
        if (
          request.method === "DELETE" &&
          request.url.includes(
            "/securityPolicies/workspace-sandbox-edge-policy"
          )
        ) {
          return {
            status: 200,
            body: { name: "op-del-policy", status: "DONE" },
          };
        }
        return {
          status: 500,
          body: {
            error: { message: `unexpected ${request.method} ${request.url}` },
          },
        };
      },
    });

    expect(result.exit._tag).toBe("Success");
    expect(result.remainingRows).toEqual([]);

    const deletes = result.calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(3);
    for (const call of deletes) {
      expect(new URL(call.url).searchParams.get("requestId")).toBeTruthy();
    }
    const dynamicDeleteIndex = result.calls.findIndex(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes("/backendServices/workspace-sandbox-dynamic-backend")
    );
    const staticDeleteIndex = result.calls.findIndex(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes("/backendServices/workspace-sandbox-static-backend")
    );
    const policyDeleteIndex = result.calls.findIndex(
      (call) =>
        call.method === "DELETE" &&
        call.url.includes("/securityPolicies/workspace-sandbox-edge-policy")
    );
    // Both backends must be deleted before the security policy they referenced.
    expect(dynamicDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(staticDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(policyDeleteIndex).toBeGreaterThan(dynamicDeleteIndex);
    expect(policyDeleteIndex).toBeGreaterThan(staticDeleteIndex);
    expect(operationsPolled.get("op-del-static")).toBe(2);
    expect(
      deletes.filter((call) =>
        call.url.includes("/backendServices/workspace-sandbox-static-backend")
      )
    ).toHaveLength(1);
  });

  test("enforces the writer lock fence before touching pre-rename state or Compute", async () => {
    const missing = await runFencedDestroy({
      rows: preRenameRows(),
      writer: Option.none(),
      handler: () => ({ status: 500 }),
    });
    expect(Exit.isFailure(missing.exit)).toBe(true);
    if (Exit.isFailure(missing.exit)) {
      expect(Cause.pretty(missing.exit.cause)).toContain(
        "ReleaseWriterRequired"
      );
    }
    expect(missing.calls).toEqual([]);
    expect(missing.remainingRows).toHaveLength(3);

    const wrongToken = await runFencedDestroy({
      rows: preRenameRows(),
      writer: Option.some(Redacted.make("wrong-token")),
      handler: () => ({ status: 500 }),
    });
    expect(Exit.isFailure(wrongToken.exit)).toBe(true);
    if (Exit.isFailure(wrongToken.exit)) {
      expect(Cause.pretty(wrongToken.exit.cause)).toContain(
        "ReleaseWriterLost"
      );
    }
    expect(wrongToken.calls).toEqual([]);
    expect(wrongToken.remainingRows).toHaveLength(3);
  });

  test("recovers an attr-less interrupted create row via read and deletes the owned object", async () => {
    const creatingRow = {
      DynamicEdgeBackend: {
        resourceType: "DeskohubWorkspace.EdgeBackendService",
        namespace: undefined,
        fqn: "DynamicEdgeBackend",
        logicalId: "DynamicEdgeBackend",
        instanceId: "inst-interrupted",
        providerVersion: 0,
        status: "creating",
        downstream: [],
        bindings: [],
        props: {
          project: sandboxConfig.projectId,
          name: "workspace-sandbox-dynamic-backend",
        },
      },
    } satisfies Record<string, ResourceState>;
    const result = await runFencedDestroy({
      rows: creatingRow,
      writer: Option.some(testWriterToken),
      handler: (request) => {
        if (request.method === "GET") {
          return {
            status: 200,
            body: {
              id: "backend-id-recovered",
              name: "workspace-sandbox-dynamic-backend",
              description: ownedDescriptionFor("DynamicEdgeBackend"),
            },
          };
        }
        if (request.method === "DELETE") {
          return {
            status: 200,
            body: { name: "op-del-recovered", status: "DONE" },
          };
        }
        return { status: 500 };
      },
    });
    expect(result.exit._tag).toBe("Success");
    expect(result.remainingRows).toEqual([]);
    expect(
      result.calls.filter((call) => call.method === "DELETE")
    ).toHaveLength(1);
  });

  test("treats already-gone objects as deleted and never deletes a foreign same-name object", async () => {
    const result = await runFencedDestroy({
      rows: preRenameRows(),
      writer: Option.some(testWriterToken),
      handler: (request) => {
        if (
          request.method === "GET" &&
          request.url.includes(
            "/backendServices/workspace-sandbox-dynamic-backend"
          )
        ) {
          // Already gone on GET.
          return { status: 404 };
        }
        if (
          request.method === "GET" &&
          request.url.includes(
            "/backendServices/workspace-sandbox-static-backend"
          )
        ) {
          // Recreated by someone else: different ID and no Alchemy marker.
          return {
            status: 200,
            body: {
              id: "foreign-backend-999",
              name: "workspace-sandbox-static-backend",
              description: "manually created",
            },
          };
        }
        if (
          request.method === "GET" &&
          request.url.includes(
            "/securityPolicies/workspace-sandbox-edge-policy"
          )
        ) {
          return {
            status: 200,
            body: { id: "policy-id-1", name: "workspace-sandbox-edge-policy" },
          };
        }
        if (
          request.method === "DELETE" &&
          request.url.includes(
            "/securityPolicies/workspace-sandbox-edge-policy"
          )
        ) {
          // Raced to 404 on DELETE.
          return { status: 404 };
        }
        return { status: 500 };
      },
    });

    expect(result.exit._tag).toBe("Success");
    expect(result.remainingRows).toEqual([]);
    const deletes = result.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.url)).toEqual([
      expect.stringContaining(
        "/securityPolicies/workspace-sandbox-edge-policy"
      ),
    ]);
  });

  test("refuses reconcile on retired edge providers without touching Compute", async () => {
    const { calls, layer: httpLayer } = fakeHttpClient(() => ({ status: 500 }));
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* tryFindProviderByType(
          "DeskohubWorkspace.EdgeBackendService"
        );
        const policy = yield* tryFindProviderByType(
          "DeskohubWorkspace.EdgeSecurityPolicy"
        );
        if (Option.isNone(backend) || Option.isNone(policy)) {
          throw new Error("expected retired edge providers to be registered");
        }
        const baseInput = {
          id: "DynamicEdgeBackend",
          fqn: "DynamicEdgeBackend",
          instanceId: "inst-1",
          news: { project: sandboxConfig.projectId, name: "test" },
          olds: undefined,
          output: undefined,
          bindings: [],
        };
        const session = {
          note: () => Effect.void,
        };
        const backendExit = yield* Effect.exit(
          backend.value.reconcile({ ...baseInput, session })
        );
        const policyExit = yield* Effect.exit(
          policy.value.reconcile({ ...baseInput, session })
        );
        return { backendExit, policyExit };
      }).pipe(
        Effect.provide(
          retiredEdgeProviders.pipe(
            Layer.provide(Layer.mergeAll(fakeCredentials, httpLayer))
          )
        ),
        Effect.provideService(Stage, "sandbox"),
        Effect.provideService(Stack.Stack, {
          name: "DeskohubWorkspace",
          stage: "sandbox",
          resources: {},
          bindings: {},
          actions: {},
        })
      )
    );

    expect(Exit.isFailure(exits.backendExit)).toBe(true);
    expect(Exit.isFailure(exits.policyExit)).toBe(true);
    if (Exit.isFailure(exits.backendExit)) {
      expect(Cause.pretty(exits.backendExit.cause)).toContain(
        "RetiredEdgeResource"
      );
    }
    if (Exit.isFailure(exits.policyExit)) {
      expect(Cause.pretty(exits.policyExit.cause)).toContain(
        "RetiredEdgeResource"
      );
    }
    expect(calls).toEqual([]);
  });

  test("registers both retired edge deletion providers on the workspace stack", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* tryFindProviderByType(
          "DeskohubWorkspace.EdgeBackendService"
        );
        const policy = yield* tryFindProviderByType(
          "DeskohubWorkspace.EdgeSecurityPolicy"
        );
        return {
          hasBackend: Option.isSome(backend),
          hasPolicy: Option.isSome(policy),
        };
      }).pipe(
        Effect.provide(
          workspaceStack.providers.pipe(Layer.provide(alchemyTestPlatform))
        ),
        provideFreshArtifactStore,
        Effect.provide(alchemyTestPlatform),
        Effect.provideService(Stage, "sandbox"),
        Effect.provideService(Stack.Stack, {
          name: "DeskohubWorkspace",
          stage: "sandbox",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.scoped
      )
    );
    expect(found).toEqual({ hasBackend: true, hasPolicy: true });
  });
});
