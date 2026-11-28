import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProbeRejected,
  SandboxProbeRpcs,
} from "@deskohub/workspace-cloud-run/sandbox-probe/rpcs";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Stream from "effect/Stream";
import {
  type CountFrames,
  observeCountFrames,
  type ProbeTarget,
  runSandboxRpcProbe,
  schemaBinaryContentType,
} from "./probe-client";
import { probeVersion, runWithProbe } from "./probe-server.test-utils";

const marker = "synthetic-probe-marker-41aa";
const digest = new Bun.CryptoHasher("sha256").update(marker).digest("hex");
const idToken = "synthetic-id-token-9f2e";
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const packageDir = join(import.meta.dir, "..");

const targetAt = (origin: string): ProbeTarget => ({
  url: origin,
  idToken,
  marker,
  traceparent,
  expectVersion: probeVersion,
});

const scratchDirs: string[] = [];

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("sandbox RPC probe verdict", () => {
  test("passes against the api role", async () => {
    const verdict = await runWithProbe("api", ({ origin }) =>
      runSandboxRpcProbe(targetAt(`${origin}/`))
    );
    expect(verdict).toEqual({
      ok: true,
      version: probeVersion,
      status: 200,
      contentType: schemaBinaryContentType,
      markerSha256: digest,
      markerMatches: true,
      failDecoded: "ProbeRejected",
      countChunks: [0, 1, 2],
      failures: [],
    });
  });

  test("accepts a matching version with build metadata", async () => {
    const version = "1.2.3+build.7";
    const verdict = await runWithProbe(
      "api",
      ({ origin }) =>
        runSandboxRpcProbe({ ...targetAt(origin), expectVersion: version }),
      version
    );
    expect(verdict).toMatchObject({ ok: true, version, failures: [] });
  });

  test("fails on an unexpected build version", async () => {
    const verdict = await runWithProbe("api", ({ origin }) =>
      runSandboxRpcProbe({ ...targetAt(origin), expectVersion: "v9" })
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.version).toBe(probeVersion);
    expect(verdict.failures).toHaveLength(1);
  });

  test("fails when the service mounts no /rpc", async () => {
    const verdict = await runWithProbe("tasks-worker", ({ origin }) =>
      runSandboxRpcProbe(targetAt(origin))
    );
    expect(verdict).toMatchObject({
      ok: false,
      version: probeVersion,
      status: 404,
      markerSha256: "",
      markerMatches: false,
      failDecoded: null,
      countChunks: [],
    });
    expect(verdict.failures.length).toBeGreaterThan(0);
  });

  test("sends the bearer token and traceparent on every request", async () => {
    const seen: Array<{ path: string; authorization: string; trace: string }> =
      [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization") ?? "",
          trace: request.headers.get("traceparent") ?? "",
        });
        return new Response("denied", { status: 403 });
      },
    });
    try {
      const verdict = await Effect.runPromise(
        runSandboxRpcProbe(targetAt(server.url.origin)).pipe(
          Effect.provide(FetchHttpClient.layer)
        )
      );
      expect(verdict).toMatchObject({ ok: false, version: null, status: 403 });
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.map(({ path }) => path)).toContain("/health");
      expect(seen.map(({ path }) => path)).toContain("/rpc/");
      expect(
        seen.every(
          ({ authorization, trace }) =>
            authorization === `Bearer ${idToken}` && trace === traceparent
        )
      ).toBe(true);
      expect(JSON.stringify(verdict)).not.toContain(idToken);
      expect(JSON.stringify(verdict)).not.toContain(marker);
    } finally {
      await server.stop(true);
    }
  });
});

/** A probe impostor that echoes the marker everywhere and streams one frame. */
const echoingProbe = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/health",
    HttpServerResponse.json({ status: "ok", version: marker })
  ),
  RpcServer.layerHttp({
    group: SandboxProbeRpcs,
    path: "/rpc",
    protocol: "http",
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcSerialization.layerSchemaBinary(),
        SandboxProbeRpcs.toLayer({
          "Probe.ingest": (payload) =>
            Effect.succeed({ markerSha256: payload.marker }),
          "Probe.fail": () =>
            Effect.fail(new ProbeRejected({ reason: marker })),
          "Probe.count": () => Stream.make(0, 1, 2),
        })
      )
    )
  )
);

describe("Probe.count frame counting", () => {
  test("counts only frames for the in-flight call, until its exit", async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function* () {
        const countFrames = yield* Ref.make<CountFrames>({
          activeId: undefined,
          frames: 0,
        });
        const protocol = observeCountFrames(
          {
            send: () => Effect.void,
            run: (_clientId, onMessage) =>
              Effect.forEach(
                [
                  { _tag: "Chunk", requestId: "9", values: [0] },
                  { _tag: "Chunk", requestId: 9, values: [0] },
                  { _tag: "Chunk", requestId: 9, values: [1] },
                  {
                    _tag: "Exit",
                    requestId: 9,
                    exit: { _tag: "Success", value: null },
                  },
                  { _tag: "Chunk", requestId: 9, values: [2] },
                ] as const,
                onMessage,
                { discard: true }
              ).pipe(Effect.andThen(Effect.never)),
          },
          countFrames
        );
        yield* protocol.send(0, {
          _tag: "Request",
          id: 9,
          tag: "Probe.count",
          payload: { n: 3 },
          headers: [],
        });
        yield* protocol
          .run(0, () => Effect.void)
          .pipe(Effect.timeoutOption("50 millis"));
        return yield* Ref.get(countFrames);
      })
    );
    expect(frames).toEqual({ activeId: undefined, frames: 2 });
  });
});

describe("sandbox RPC probe verdict against an impostor", () => {
  test("redacts echoed secrets and rejects a single-frame count", async () => {
    const verdict = await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        return yield* runSandboxRpcProbe({
          ...targetAt(HttpServer.formatAddress(server.address)),
          expectVersion: "v2",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            HttpRouter.serve(echoingProbe, {
              disableLogger: true,
              disableListenLog: true,
            }).pipe(
              Layer.provideMerge(
                NodeHttpServer.layer(createServer, {
                  port: 0,
                  host: "127.0.0.1",
                })
              )
            ),
            FetchHttpClient.layer
          )
        ),
        Effect.scoped
      )
    );
    expect(verdict).toMatchObject({
      ok: false,
      version: "[redacted]",
      markerSha256: "",
      markerMatches: false,
      failDecoded: "ProbeRejected",
      countChunks: [],
    });
    expect(
      verdict.failures.some((failure) => failure.startsWith("Probe.count"))
    ).toBe(true);
    expect(JSON.stringify(verdict)).not.toContain(marker);
  });
});

describe("sandbox-rpc-probe CLI", () => {
  const runCli = (
    origin: string,
    expectVersion: string,
    writeToken = true,
    markerContent = `${marker}\n`
  ) =>
    Effect.promise(async () => {
      const dir = await mkdtemp(join(tmpdir(), "sandbox-rpc-probe-"));
      scratchDirs.push(dir);
      if (writeToken) {
        await Bun.write(join(dir, "token"), `${idToken}\n`);
      }
      await Bun.write(join(dir, "marker"), markerContent);
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/sandbox-rpc-probe.ts",
          "--url",
          origin,
          "--id-token-file",
          join(dir, "token"),
          "--marker-file",
          join(dir, "marker"),
          "--traceparent",
          traceparent,
          "--expect-version",
          expectVersion,
        ],
        { cwd: packageDir, stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    });

  test("prints one ok verdict line and exits 0", async () => {
    const { stdout, stderr, exitCode } = await runWithProbe(
      "api",
      ({ origin }) => runCli(origin, probeVersion)
    );
    expect(exitCode).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      ok: true,
      markerSha256: digest,
      markerMatches: true,
    });
    expect(stdout + stderr).not.toContain(idToken);
    expect(stdout + stderr).not.toContain(marker);
  });

  test("exits non-zero on a failing verdict", async () => {
    const { stdout, stderr, exitCode } = await runWithProbe(
      "api",
      ({ origin }) => runCli(origin, "v9")
    );
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    expect(stdout + stderr).not.toContain(idToken);
  });

  test("prints a failing verdict when an input file is unreadable", async () => {
    const { stdout, exitCode } = await runWithProbe("api", ({ origin }) =>
      runCli(origin, probeVersion, false)
    );
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      version: null,
      countChunks: [],
    });
  });

  test("refuses an empty marker file with a failing verdict", async () => {
    const { stdout, exitCode } = await runWithProbe("api", ({ origin }) =>
      runCli(origin, probeVersion, true, "\n")
    );
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      failures: ["setup: --marker-file is empty"],
    });
  });
});
