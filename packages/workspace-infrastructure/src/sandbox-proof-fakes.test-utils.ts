import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import {
  isLockedStackAction,
  lockedStackInvocation,
} from "../scripts/sandbox-locked-stack-actions";

/**
 * Stateful fakes of the CLIs the sandbox proof runner calls, for offline
 * behavioural tests. Every tool on PATH is a shell shim; the stateful ones
 * run this file with real Bun, and the shared state ("world") lives in a
 * JSON file so a fake can observe what an earlier call, or a still-running
 * one, changed. `date` and `sleep` are plain shell over a fake clock file:
 * the runner calls them in polling loops, and a `sleep` advances the clock
 * so a deadline loop ends without waiting.
 */

/** One canned answer: the first rule whose tool and pattern match wins. */
export interface FakeRule {
  readonly tool: string;
  /** A regular expression over the space-joined arguments. */
  readonly pattern: string;
  readonly stdout?: string;
  /** Written to stderr, as logs and Alchemy's plan are. */
  readonly stderr?: string;
  readonly exit?: number;
  /** World keys this call sets before it answers. */
  readonly set?: Partial<FakeWorld>;
  /** Seconds this call advances the fake clock by. */
  readonly advance?: number;
}

/** One state object: its live generation, if any, and every generation. */
export interface FakeObject {
  readonly live: string | null;
  /** CRC32C of each generation the bucket still holds. */
  readonly generations: Record<string, string>;
}

export interface FakeWorld {
  readonly rules?: ReadonlyArray<FakeRule>;
  /** Versioned objects of the state bucket, by object name. */
  readonly objects?: Record<string, FakeObject>;
  /** Whether an object listing also returns noncurrent generations. */
  readonly listNoncurrent?: boolean;
  readonly nextGeneration?: number;
  /** Plain files copied to or from the state bucket, by object name. */
  readonly files?: Record<string, string>;
  /** `bun release.run.ts status` prints this. */
  readonly status?: unknown;
  /** The persisted Cloud Run generation of each service. */
  readonly serviceGenerations?: Record<string, number>;
  /**
   * How a deliver started with an interrupt token behaves: `apply` persists
   * a Cloud Run change, leaves a detached child in its own session and
   * hangs; `exit` changes nothing and exits.
   */
  readonly interruptedDeliver?: "apply" | "exit" | "exit-after-failed-read";
  /** Cloud Run service reads fail once an interrupted deliver has started. */
  readonly serviceReadsFailAfterDeliver?: boolean;
  /** Set by any deliver started with an interrupt token. */
  readonly deliverStarted?: boolean;
  /** Cloud Run service reads that failed, counted by the fake. */
  readonly failedServiceReads?: number;
  /** Set by an `apply` deliver: the detached child's process ID. */
  readonly detachedChildPid?: number;
  /**
   * Seconds each access token has left, by token, as tokeninfo answers;
   * an unknown token gets a 400.
   */
  readonly tokenLifetimes?: Record<string, number>;
  /** Seconds the fake clock moves while tokeninfo answers. */
  readonly tokeninfoDelay?: number;
  /** The Artifact Registry repository's description, as gcloud reads it. */
  readonly repositoryDescription?: string;
  readonly schedulerJob?: Schema.JsonObject;
  readonly schedulerRunAccepted?: boolean;
  /** The fake clock's start, in epoch seconds; defaults to the real clock. */
  readonly now?: number;
  /**
   * When set, `bun scripts/sandbox-rpc-probe.ts` prints a passing verdict
   * for the marker file it is given, with these fields laid over it.
   */
  readonly rpcVerdict?: Schema.JsonObject;
  /** The fake RPC probe also prints the raw marker in its failures. */
  readonly rpcPrintsMarker?: boolean;
  /** The fake RPC probe's exit status. */
  readonly rpcExit?: number;
}

/**
 * The flags `alchemy drift` defines in alchemy 2.0.0-beta.87
 * (lib/Cli/commands/drift.js), by whether each takes a value. Unlike
 * deploy, destroy and plan it has no positional entrypoint.
 */
const driftFlags = new Map([
  ["--config", true],
  ["-c", true],
  ["--stage", true],
  ["--profile", true],
  ["--env-file", true],
  ["--repair", false],
  ["--yes", false],
  ["-y", false],
  ["--no-input", false],
]);

/** Why Alchemy would reject a drift command line, if it would. */
const driftArgumentError = (args: ReadonlyArray<string>) => {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const takesValue = driftFlags.get(arg);
    if (takesValue === undefined) {
      return arg.startsWith("-")
        ? `Unknown flag: ${arg}`
        : `Unexpected positional argument: "${arg}"`;
    }
    if (takesValue) {
      index += 1;
    }
  }
  return undefined;
};

/**
 * A locked action's real command line, checked as Alchemy would parse it
 * before any canned outcome is returned.
 */
const lockedStackArgumentError = (action: string | undefined) => {
  if (!isLockedStackAction(action)) {
    return undefined;
  }
  const { args } = lockedStackInvocation(action, "sandbox");
  return args[0] === "drift" ? driftArgumentError(args) : undefined;
};

/** The writer token an `apply` deliver hands its detached Alchemy child. */
const fakeWriterToken = "fake-writer-token";
/** The lock holder an `apply` deliver records: its token's fingerprint. */
export const fakeWriterFingerprint = createHash("sha256")
  .update(fakeWriterToken)
  .digest("hex")
  .slice(0, 12);

const realBun = process.execPath;
const realDate = Bun.which("date") ?? "/bin/date";
const realSetsid = Bun.which("setsid") ?? "/usr/bin/setsid";
const realSleep = Bun.which("sleep") ?? "/bin/sleep";
const fakeTools = ["gcloud", "bun", "curl", "docker"];

/**
 * `date +%s` and `date -u +%s` read the fake clock; any other form is the
 * real `date`. A `sleep` advances the clock by its whole seconds, rounded
 * up, and really waits only briefly, so loops waiting on real processes
 * still yield to them.
 */
const clockShims = (clockFile: string): Record<string, string> => ({
  date: `#!/bin/sh
if [ "$*" = "+%s" ] || [ "$*" = "-u +%s" ]; then
  exec cat "${clockFile}"
fi
exec "${realDate}" "$@"
`,
  sleep: `#!/bin/sh
whole=\${1%%.*}
case "$1" in *.*) whole=$((\${whole:-0} + 1)) ;; esac
echo $(($(cat "${clockFile}") + \${whole:-0})) > "${clockFile}.next"
mv "${clockFile}.next" "${clockFile}"
exec "${realSleep}" 0.02
`,
});

/** A line on the fake tool's stdout. */
const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};

/*
 * The fake CLIs read the world on every call, so it is checked with plain
 * predicates: loading Effect Schema would add about 60 ms to each call.
 */
/** A JSON value from the world file; a missing field reads as undefined. */
type WorldValue = Schema.Json | undefined;
type WorldCheck = (value: WorldValue) => boolean;

const isJsonObject = (value: WorldValue): value is Schema.JsonObject =>
  Predicate.isReadonlyObject(value) && !Array.isArray(value);
const isOptional =
  (is: WorldCheck) =>
  (value: WorldValue): boolean =>
    value === undefined || is(value);
const isArrayOf =
  (is: WorldCheck) =>
  (value: WorldValue): boolean =>
    Array.isArray(value) && value.every(is);
const isRecordOf =
  (is: WorldCheck) =>
  (value: WorldValue): boolean =>
    isJsonObject(value) && Object.values(value).every(is);
const hasFields = (
  value: WorldValue,
  fields: Readonly<Record<string, WorldCheck>>
) =>
  isJsonObject(value) &&
  Object.entries(fields).every(([key, is]) => is(value[key]));

const optionalString = isOptional(Predicate.isString);
const optionalNumber = isOptional(Predicate.isNumber);
const optionalBoolean = isOptional(Predicate.isBoolean);

const isFakeRule = (value: WorldValue) =>
  hasFields(value, {
    tool: Predicate.isString,
    pattern: Predicate.isString,
    stdout: optionalString,
    exit: optionalNumber,
    set: isOptional(Predicate.isReadonlyObject),
    advance: optionalNumber,
  });

const isFakeObject = (value: WorldValue) =>
  hasFields(value, {
    live: Predicate.or(Predicate.isString, Predicate.isNull),
    generations: isRecordOf(Predicate.isString),
  });

const interruptedDeliveries: ReadonlyArray<unknown> = [
  "apply",
  "exit",
  "exit-after-failed-read",
] satisfies ReadonlyArray<FakeWorld["interruptedDeliver"]>;

const isFakeWorld = (
  value: WorldValue
): value is FakeWorld & Schema.JsonObject =>
  hasFields(value, {
    rules: isOptional(isArrayOf(isFakeRule)),
    objects: isOptional(isRecordOf(isFakeObject)),
    listNoncurrent: optionalBoolean,
    nextGeneration: optionalNumber,
    files: isOptional(isRecordOf(Predicate.isString)),
    serviceGenerations: isOptional(isRecordOf(Predicate.isNumber)),
    interruptedDeliver: isOptional((field) =>
      interruptedDeliveries.includes(field)
    ),
    serviceReadsFailAfterDeliver: optionalBoolean,
    deliverStarted: optionalBoolean,
    failedServiceReads: optionalNumber,
    detachedChildPid: optionalNumber,
    tokenLifetimes: isOptional(isRecordOf(Predicate.isNumber)),
    tokeninfoDelay: optionalNumber,
    schedulerJob: isOptional(isJsonObject),
    schedulerRunAccepted: optionalBoolean,
    now: optionalNumber,
    rpcVerdict: isOptional(isJsonObject),
    rpcPrintsMarker: optionalBoolean,
    rpcExit: optionalNumber,
  });

const readWorld = (path: string): FakeWorld => {
  const world: Schema.Json = JSON.parse(readFileSync(path, "utf8"));
  if (!isFakeWorld(world)) {
    throw new Error(`the fake world in ${path} is malformed`);
  }
  return world;
};

const writeWorld = (path: string, world: FakeWorld) => {
  writeFileSync(`${path}.next`, JSON.stringify(world));
  renameSync(`${path}.next`, path);
};

export interface ProofFakes {
  readonly env: Record<string, string>;
  readonly proofDir: string;
  /** The runner's private directory: the marker and ID token file. */
  readonly privateDir: string;
  readonly world: () => FakeWorld;
  readonly calls: () => ReadonlyArray<string>;
}

/** Run with fake tools on PATH and a fresh proof directory. */
export const withProofFakes = <A>(
  world: FakeWorld,
  run: (fakes: ProofFakes) => A
): A => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-proof-fakes-"));
  const bin = join(dir, "bin");
  const proofDir = join(dir, "proof");
  const privateDir = join(dir, "private");
  const worldFile = join(dir, "world.json");
  const callsLog = join(dir, "calls.log");
  const clockFile = join(dir, "clock");
  mkdirSync(bin);
  mkdirSync(proofDir);
  writeWorld(worldFile, world);
  writeFileSync(clockFile, `${world.now ?? Math.floor(Date.now() / 1000)}\n`);
  const shims: Record<string, string> = clockShims(clockFile);
  for (const tool of fakeTools) {
    shims[tool] =
      `#!/bin/sh\nexec "${realBun}" "${import.meta.path}" ${tool} "$@"\n`;
  }
  for (const [tool, script] of Object.entries(shims)) {
    const shim = join(bin, tool);
    writeFileSync(shim, script);
    chmodSync(shim, 0o755);
  }
  try {
    return run({
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SANDBOX_PROOF_DIR: proofDir,
        SANDBOX_PROOF_PRIVATE_DIR: privateDir,
        FAKE_WORLD: worldFile,
        FAKE_CALLS: callsLog,
        FAKE_CLOCK: clockFile,
      },
      proofDir,
      privateDir,
      world: () => readWorld(worldFile),
      calls: () =>
        existsSync(callsLog)
          ? readFileSync(callsLog, "utf8").split("\n").filter(Boolean)
          : [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ------------------------------------------------------------ the fake tool

const flag = (args: ReadonlyArray<string>, name: string) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

const objectName = (url: string, bucketPrefix = /^gs:\/\/[^/]+\//) =>
  url.replace(bucketPrefix, "");

/** gcloud storage against the versioned state-object store. */
const fakeStorage = (
  args: ReadonlyArray<string>,
  world: FakeWorld,
  save: (next: FakeWorld) => void
): number | undefined => {
  const [group, verb] = args;
  if (group !== "storage") {
    return undefined;
  }
  const objects = { ...(world.objects ?? {}) };
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (verb === "objects" && positional[2] === "list") {
    const prefix = objectName(positional[3] ?? "").replace(/\*+$/, "");
    for (const [name, object] of Object.entries(objects)) {
      if (!name.startsWith(prefix)) continue;
      const liveCopies = object.live === null ? 0 : 1;
      const copies = world.listNoncurrent
        ? Object.keys(object.generations).length
        : liveCopies;
      for (let copy = 0; copy < copies; copy += 1) {
        print(name);
      }
    }
    return 0;
  }
  if (verb === "objects" && positional[2] === "describe") {
    const name = objectName(positional[3] ?? "");
    const object = objects[name];
    if (object?.live == null) {
      console.error(`ERROR: gs://bucket/${name} not found`);
      return 1;
    }
    const format = flag(args, "--format") ?? "";
    print(
      format.includes("value(generation)")
        ? object.live
        : JSON.stringify({
            name,
            generation: Number(object.live),
            crc32c_hash: object.generations[object.live],
          })
    );
    return 0;
  }
  if (verb === "cat") {
    const content = world.files?.[objectName(positional[2] ?? "")];
    if (content === undefined) {
      console.error("ERROR: One or more URLs matched no objects.");
      return 1;
    }
    process.stdout.write(content);
    return 0;
  }
  if (verb === "cp" || verb === "rm") {
    const [source = "", target = ""] = positional.slice(2);
    const remote = verb === "rm" ? source : target;
    if (verb === "cp" && !source.startsWith("gs://")) {
      // A local file uploaded as a plain object.
      const files = { ...(world.files ?? {}) };
      files[objectName(target)] = readFileSync(source, "utf8");
      save({ ...world, files });
      return 0;
    }
    if (verb === "cp" && !target.startsWith("gs://")) {
      const content = world.files?.[objectName(source)];
      if (content === undefined) {
        console.error("ERROR: not found");
        return 1;
      }
      writeFileSync(target, content);
      return 0;
    }
    const name = objectName(remote);
    const current = objects[name] ?? { live: null, generations: {} };
    const precondition = flag(args, "--if-generation-match");
    if (precondition !== undefined && precondition !== (current.live ?? "0")) {
      console.error("ERROR: 412 Precondition Failed");
      return 1;
    }
    if (verb === "rm") {
      if (current.live === null) {
        if (world.files?.[name] === undefined) return 1;
        const files = { ...(world.files ?? {}) };
        delete files[name];
        save({ ...world, files });
        return 0;
      }
      objects[name] = { ...current, live: null };
      save({ ...world, objects });
      return 0;
    }
    const [sourceObject = "", sourceGeneration = ""] =
      objectName(source).split("#");
    const crc = objects[sourceObject]?.generations[sourceGeneration];
    if (crc === undefined) {
      console.error("ERROR: source generation not found");
      return 1;
    }
    const generation = String(world.nextGeneration ?? 1000);
    objects[name] = {
      live: generation,
      generations: { ...current.generations, [generation]: crc },
    };
    save({ ...world, objects, nextGeneration: Number(generation) + 1 });
    return 0;
  }
  return undefined;
};

/** A deliver run under an interrupt token: see `interruptedDeliver`. */
const interruptedDeliver = async (
  world: FakeWorld,
  save: (next: FakeWorld) => void
) => {
  save({ ...world, deliverStarted: true });
  if (world.interruptedDeliver === "exit-after-failed-read") {
    // Keep running, changing nothing, until the runner has seen a read fail.
    const worldFile = process.env.FAKE_WORLD ?? "";
    while ((readWorld(worldFile).failedServiceReads ?? 0) < 1) {
      await Bun.sleep(10);
    }
    return 0;
  }
  if (world.interruptedDeliver !== "apply") {
    return 0;
  }
  const pidFile = `${process.env.FAKE_WORLD}.child`;
  // A detached child in its own session, like Alchemy under Bun's spawner.
  Bun.spawn(
    [realSetsid, "sh", "-c", `echo $$ > "${pidFile}"; exec tail -f /dev/null`],
    {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, WORKSPACE_RELEASE_WRITER: fakeWriterToken },
    }
  );
  while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") {
    await Bun.sleep(10);
  }
  const generations = { ...(world.serviceGenerations ?? {}) };
  generations["workspace-api"] = (generations["workspace-api"] ?? 1) + 1;
  save({
    ...world,
    serviceGenerations: generations,
    detachedChildPid: Number(readFileSync(pidFile, "utf8").trim()),
    status: {
      version: "1",
      record: {
        generation: 7,
        writer: { holder: fakeWriterFingerprint },
        pendingApply: null,
      },
    },
  });
  // Hang like an apply in flight until killed.
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
  return 0;
};

/** Move the fake clock on, as a slow call would. */
const fakeImage =
  "europe-west1-docker.pkg.dev/deskohub-workspace-sandbox/workspace/workspace";

/** The run.app URL the fake reports for a Cloud Run service. */
export const fakeServiceUrl = (service: string) =>
  `https://${service}-759037106024.europe-west1.run.app`;

/** The hash-based run.app URL Cloud Run may report as a service's primary URL. */
export const fakeHashUrl = (service: string) =>
  `https://${service}-a1b2c3d4e5-ew.a.run.app`;

/**
 * A Ready service sending all its traffic to one live revision, with the
 * hash-based URL as its primary URL and the deterministic one an alias.
 */
const fakeReadyService = (service: string) => {
  const ingress = "all";
  return {
    metadata: {
      name: service,
      generation: 2,
      annotations: {
        "run.googleapis.com/ingress": ingress,
        "run.googleapis.com/ingress-status": ingress,
        "run.googleapis.com/urls": JSON.stringify([
          fakeHashUrl(service),
          fakeServiceUrl(service),
        ]),
      },
    },
    status: {
      observedGeneration: 2,
      url: fakeHashUrl(service),
      conditions: [{ type: "Ready", status: "True" }],
      traffic: [{ revisionName: `${service}-live`, percent: 100 }],
    },
  };
};

/** The image digest of the release `release status` reports active. */
const activeDigest = async ({ status }: FakeWorld) => {
  // Only revision descriptions need this schema. Each fake CLI call is a
  // new process, so importing it eagerly slows unrelated commands too.
  const { is, String: StringSchema, Struct } = await import("effect/Schema");
  const isActiveRelease = is(
    Struct({
      record: Struct({ active: Struct({ imageDigest: StringSchema }) }),
    })
  );
  return isActiveRelease(status) ? status.record.active.imageDigest : undefined;
};

/** The RPC probe CLI's verdict for the marker file it was handed. */
const fakeRpcProbe = (args: ReadonlyArray<string>, world: FakeWorld) => {
  const markerFile = args[args.indexOf("--marker-file") + 1] ?? "";
  const marker = readFileSync(markerFile, "utf8");
  print(
    JSON.stringify({
      ok: true,
      version: args[args.indexOf("--expect-version") + 1] ?? null,
      status: 200,
      contentType: "application/vnd.effect.rpc+schema-binary",
      markerSha256: createHash("sha256").update(marker).digest("hex"),
      markerMatches: true,
      failDecoded: "ProbeRejected",
      countChunks: [0, 1, 2],
      emailPreferences: {
        opened: true,
        rejected: "CampaignUnsubscribeRejected",
        first: "withdrawn",
        repeat: "unchanged",
      },
      failures: world.rpcPrintsMarker === true ? [marker] : [],
      ...world.rpcVerdict,
    })
  );
  return world.rpcExit ?? 0;
};

const advanceClock = (seconds: number) => {
  if (seconds === 0) return;
  const clock = process.env.FAKE_CLOCK ?? "";
  const now = Number(readFileSync(clock, "utf8").trim());
  writeFileSync(`${clock}.next`, `${now + seconds}\n`);
  renameSync(`${clock}.next`, clock);
};

const runFake = async (tool: string, args: ReadonlyArray<string>) => {
  const worldFile = process.env.FAKE_WORLD ?? "";
  appendFileSync(process.env.FAKE_CALLS ?? "", `${tool} ${args.join(" ")}\n`);
  let world = readWorld(worldFile);
  const save = (next: FakeWorld) => {
    world = next;
    writeWorld(worldFile, next);
  };
  // The package's own stack config runs for real.
  if (tool === "bun" && args[0] === "scripts/sandbox-stack-config.ts") {
    return Bun.spawnSync([realBun, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
    }).exitCode;
  }
  if (
    tool === "bun" &&
    args[0] === "release.run.ts" &&
    args[1] === "deliver" &&
    process.env.SANDBOX_PROOF_INTERRUPT_TOKEN !== undefined
  ) {
    return interruptedDeliver(world, save);
  }
  if (tool === "bun" && args[0] === "scripts/sandbox-locked-stack.ts") {
    const error = lockedStackArgumentError(args[1]);
    if (error !== undefined) {
      process.stderr.write(`ERROR: ${error}\n`);
      return 1;
    }
  }
  const joined = args.join(" ");
  if (
    tool === "curl" &&
    world.tokenLifetimes !== undefined &&
    joined.includes("oauth2.googleapis.com/tokeninfo")
  ) {
    const token = (await Bun.stdin.text()).trim();
    const seconds = world.tokenLifetimes[token];
    advanceClock(world.tokeninfoDelay ?? 0);
    if (seconds === undefined) {
      print('{"error":"invalid_token"}');
      return 22;
    }
    print(JSON.stringify({ expires_in: String(seconds) }));
    return 0;
  }
  const rule = world.rules?.find(
    (candidate) =>
      candidate.tool === tool && new RegExp(candidate.pattern).test(joined)
  );
  if (rule !== undefined) {
    if (rule.set !== undefined) {
      save({ ...world, ...rule.set });
    }
    advanceClock(rule.advance ?? 0);
    if (rule.stdout !== undefined) {
      print(rule.stdout);
    }
    if (rule.stderr !== undefined) {
      process.stderr.write(`${rule.stderr}\n`);
    }
    return rule.exit ?? 0;
  }
  if (
    tool === "bun" &&
    args[0] === "scripts/sandbox-rpc-probe.ts" &&
    world.rpcVerdict !== undefined
  ) {
    return fakeRpcProbe(args, world);
  }
  if (tool === "bun" && args[0] === "release.run.ts") {
    if (args[1] === "status") {
      print(JSON.stringify(world.status ?? {}));
      return 0;
    }
    return 0;
  }
  if (tool === "curl") {
    const object = joined.match(
      /storage\.googleapis\.com\/storage\/v1\/b\/([^/]+)\/o\/([^?\s]+)/
    );
    if (object !== null) {
      // The JSON API object read, with the HTTP status `-w` appends.
      const [, bucket = "", encoded = ""] = object;
      const name = decodeURIComponent(encoded);
      const stored = world.objects?.[name];
      const live = stored?.live;
      print(
        live == null
          ? `${JSON.stringify({ error: { code: 404, message: `No such object: ${bucket}/${name}` } })}\n404`
          : `${JSON.stringify({ name, generation: live, crc32c: stored?.generations[live] })}\n200`
      );
      return 0;
    }
  }
  if (tool === "gcloud") {
    const job = world.schedulerJob;
    if (
      job !== undefined &&
      args[0] === "scheduler" &&
      args[1] === "jobs" &&
      job.name ===
        `projects/${flag(args, "--project")}/locations/${flag(args, "--location")}/jobs/${args[3]}`
    ) {
      switch (args[2]) {
        case "describe":
          print(
            flag(args, "--format") === "value(state)"
              ? String(job.state)
              : JSON.stringify(job)
          );
          return 0;
        case "resume":
          if (job.state !== "PAUSED") return 1;
          save({ ...world, schedulerJob: { ...job, state: "ENABLED" } });
          return 0;
        case "run":
          if (job.state !== "ENABLED") {
            process.stderr.write(
              "FAILED_PRECONDITION: Job.state must be ENABLED for RunJob.\n"
            );
            return 1;
          }
          save({ ...world, schedulerRunAccepted: true });
          return 0;
        case "pause":
          if (job.state !== "ENABLED") return 1;
          save({ ...world, schedulerJob: { ...job, state: "PAUSED" } });
          return 0;
      }
    }
    if (
      job !== undefined &&
      args[0] === "logging" &&
      args[1] === "read" &&
      joined.includes(
        'resource.labels.service_name="workspace-scheduler-worker"'
      ) &&
      joined.includes('jsonPayload.event="probe.schedule"') &&
      joined.includes('jsonPayload.job="proof-tick"')
    ) {
      print(
        world.schedulerRunAccepted
          ? '[{"jsonPayload":{"event":"probe.schedule"}}]'
          : "[]"
      );
      return 0;
    }
    if (args[0] === "auth" && args[1] === "print-access-token") {
      print("fake-access-token");
      return 0;
    }
    if (
      args[0] === "run" &&
      args[1] === "revisions" &&
      args[2] === "describe"
    ) {
      // Every live revision runs the release's active image.
      const digest = await activeDigest(world);
      print(`${fakeImage}@${digest ?? "sha256:none"}`);
      return 0;
    }
    if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
      const service = args[3] ?? "";
      if (flag(args, "--format") === "json") {
        print(JSON.stringify(fakeReadyService(service)));
        return 0;
      }
      if (world.serviceReadsFailAfterDeliver && world.deliverStarted) {
        save({
          ...world,
          failedServiceReads: (world.failedServiceReads ?? 0) + 1,
        });
        process.stderr.write("ERROR: 503 Service Unavailable\n");
        return 1;
      }
      print(String(world.serviceGenerations?.[args[3] ?? ""] ?? 1));
      return 0;
    }
    if (args[0] === "artifacts" && args[1] === "repositories") {
      if (args[2] === "update") {
        save({ ...world, repositoryDescription: flag(args, "--description") });
        return 0;
      }
      if (args[2] === "describe") {
        print(world.repositoryDescription ?? "");
        return 0;
      }
    }
    const storage = fakeStorage(args, world, save);
    if (storage !== undefined) {
      return storage;
    }
  }
  return 0;
};

if (import.meta.main) {
  const [tool = "", ...args] = process.argv.slice(2);
  process.exitCode = await runFake(tool, args);
}
