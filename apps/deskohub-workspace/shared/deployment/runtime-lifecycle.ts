import { subscribe } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import { waitUntil } from "@vercel/functions";
import { Data, type Duration, Effect, Predicate } from "effect";

/**
 * How the host runs and stops Workspace processes. On Vercel a function
 * instance lives per invocation and Vercel's `waitUntil` keeps it running
 * for work that outlives the response. A container host, such as Cloud Run,
 * keeps one process serving until it sends SIGTERM and then kills it after
 * a grace period, so the process drains that work and flushes telemetry
 * itself before it exits.
 *
 * The state lives on `globalThis`: Next.js evaluates modules once for
 * `instrumentation.ts` and again for the app bundles, and both must see the
 * same pending work and shutdown hooks. Hooks are plain promise thunks so
 * they cross those module instances.
 */
const runtimeLifecycleKey = Symbol.for("@deskohub-workspace/runtime-lifecycle");

/**
 * When a shutdown hook runs: after in-flight work drains, `flush` hooks
 * export telemetry, and `close` hooks release connections last.
 */
export type RuntimeShutdownStage = "flush" | "close";

export interface RuntimeShutdownHook {
  /** A stable name; registering it again replaces the earlier hook. */
  readonly name: string;
  readonly stage: RuntimeShutdownStage;
  readonly run: () => Promise<unknown>;
}

interface RuntimeLifecycle {
  /** Work the process must finish before it exits, once it tracks any. */
  readonly pending: Set<Promise<void>>;
  readonly hooks: Map<string, RuntimeShutdownHook>;
  tracksPending: boolean;
  shutdown?: Promise<void>;
}

type GlobalWithRuntimeLifecycle = typeof globalThis & {
  [runtimeLifecycleKey]?: RuntimeLifecycle;
};

const runtimeLifecycle = (): RuntimeLifecycle => {
  const holder: GlobalWithRuntimeLifecycle = globalThis;
  holder[runtimeLifecycleKey] ??= {
    pending: new Set(),
    hooks: new Map(),
    tracksPending: false,
  };
  return holder[runtimeLifecycleKey];
};

const ignoreSettlement = () => undefined;

/**
 * Keeps the runtime serving until `work` settles, after the response if
 * need be. On Vercel this is exactly `waitUntil`. A container process that
 * installed its shutdown (`installRuntimeShutdown`) also waits for the work
 * before it exits; elsewhere nothing else happens.
 */
export const keepRuntimeAliveUntil = (work: Promise<unknown>): void => {
  waitUntil(work);
  trackRuntimeWork(work);
};

/**
 * Makes a container process that installed its shutdown wait for `work`
 * before it exits. Unlike `keepRuntimeAliveUntil` it leaves Vercel alone, for
 * work Vercel already waits for, such as an `after()` callback or the
 * response a route handler returns. Elsewhere a no-op.
 */
export const trackRuntimeWork = (work: Promise<unknown>): void => {
  const lifecycle = runtimeLifecycle();
  if (!lifecycle.tracksPending) return;
  const settled = work.then(ignoreSettlement, ignoreSettlement);
  lifecycle.pending.add(settled);
  void settled.then(() => lifecycle.pending.delete(settled));
};

/** Node's channel for each request an `http.Server` starts serving. */
const httpServerRequestStartChannel = "http.server.request.start";

/**
 * Tracks every HTTP request the process serves until its response closes,
 * finished or aborted, so SIGTERM lets in-flight requests complete. Node
 * publishes each request a server starts on a diagnostics channel, which
 * reaches the Next.js standalone server without access to it.
 */
const trackHttpRequests = () =>
  subscribe(httpServerRequestStartChannel, (message) => {
    // Node publishes `{ request, response, socket, server }`; the response is
    // an `http.ServerResponse`, which is an EventEmitter with `closed`.
    if (!Predicate.hasProperty(message, "response")) return;
    const { response } = message;
    if (!(response instanceof EventEmitter)) return;
    if (!Predicate.hasProperty(response, "closed")) return;
    trackRuntimeWork(
      new Promise<void>((resolve) => {
        if (response.closed === true) resolve();
        else response.once("close", () => resolve());
      })
    );
  });

/** Runs `hook` when the process shuts down; a no-op on Vercel. */
export const onRuntimeShutdown = (hook: RuntimeShutdownHook): void => {
  runtimeLifecycle().hooks.set(hook.name, hook);
};

/**
 * Cloud Run sends SIGKILL 10 seconds after SIGTERM. Draining gets most of
 * that, and the flush and close stages keep their own share, so telemetry
 * of work that never finished still leaves the process.
 */
export interface RuntimeShutdownBudget {
  readonly drain: Duration.Input;
  readonly flush: Duration.Input;
  readonly close: Duration.Input;
}

const containerShutdownBudget: RuntimeShutdownBudget = {
  drain: "5 seconds",
  flush: "2500 millis",
  close: "1500 millis",
};

class RuntimeShutdownHookError extends Data.TaggedError(
  "RuntimeShutdownHookError"
)<{
  readonly hook: string;
  readonly cause: unknown;
}> {}

/**
 * One turn of the event loop. Work that follows a response, such as the
 * `after()` callbacks Next.js starts when the response closes, is tracked
 * only once it starts, so an empty set is final only after the turn.
 */
const nextEventLoopTurn = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve))
);

/** Waits for tracked work, including work started while it waits. */
const drainPending = (lifecycle: RuntimeLifecycle): Effect.Effect<void> =>
  Effect.suspend(() => {
    const pending = [...lifecycle.pending];
    return pending.length === 0
      ? nextEventLoopTurn.pipe(
          Effect.andThen(
            Effect.suspend(() =>
              lifecycle.pending.size === 0
                ? Effect.void
                : drainPending(lifecycle)
            )
          )
        )
      : Effect.promise(() => Promise.all(pending)).pipe(
          Effect.andThen(drainPending(lifecycle))
        );
  });

/** Names a shutdown log record's event for structured log queries. */
const shutdownEvent = (event: string) => Effect.annotateLogs({ event });

const runHook = (hook: RuntimeShutdownHook) =>
  Effect.tryPromise({
    try: hook.run,
    catch: (cause) => new RuntimeShutdownHookError({ hook: hook.name, cause }),
  }).pipe(
    Effect.catchTag("RuntimeShutdownHookError", ({ hook: name }) =>
      Effect.logWarning("Workspace runtime shutdown hook failed.", {
        hook: name,
      }).pipe(shutdownEvent("runtime.shutdown.hook_failed"))
    )
  );

const runStage = (
  lifecycle: RuntimeLifecycle,
  stage: RuntimeShutdownStage,
  budget: Duration.Input
) =>
  Effect.forEach(
    [...lifecycle.hooks.values()].filter((hook) => hook.stage === stage),
    runHook,
    { concurrency: "unbounded", discard: true }
  ).pipe(
    Effect.timeoutOrElse({
      duration: budget,
      orElse: () =>
        Effect.logWarning("Workspace runtime shutdown stage ran out of time.", {
          stage,
        }).pipe(shutdownEvent("runtime.shutdown.stage_timed_out")),
    })
  );

/**
 * Drains tracked work, then runs the flush hooks and then the close hooks,
 * each within its share of `budget`. Never fails.
 */
export const shutdownRuntime = Effect.fn("runtime.shutdown")(function* (
  budget: RuntimeShutdownBudget = containerShutdownBudget
) {
  const lifecycle = runtimeLifecycle();
  yield* Effect.logInfo("Workspace runtime shutdown started.", {
    pending: lifecycle.pending.size,
  }).pipe(shutdownEvent("runtime.shutdown.started"));
  yield* drainPending(lifecycle).pipe(
    Effect.timeoutOrElse({
      duration: budget.drain,
      orElse: () =>
        Effect.logWarning(
          "Workspace runtime shutdown stopped waiting for in-flight work.",
          { pending: lifecycle.pending.size }
        ).pipe(shutdownEvent("runtime.shutdown.drain_timed_out")),
    })
  );
  yield* runStage(lifecycle, "flush", budget.flush);
  yield* runStage(lifecycle, "close", budget.close);
  yield* Effect.logInfo("Workspace runtime shutdown finished.").pipe(
    shutdownEvent("runtime.shutdown.finished")
  );
});

export interface RuntimeShutdownInstallation {
  /** Runs the shutdown Effect through a Workspace runner. */
  readonly run: (shutdown: Effect.Effect<void>) => Promise<unknown>;
  /** Ends the process once the shutdown settles. */
  readonly exit: (code: number) => void;
  readonly budget?: RuntimeShutdownBudget;
  readonly signals?: readonly NodeJS.Signals[];
}

/**
 * Makes a container process track its pending work, its in-flight HTTP
 * requests among it, and, on the first termination signal, shut down within the budget and exit. Only a container
 * host installs this, and its server must leave the signals to it (Next.js
 * standalone with `NEXT_MANUAL_SIG_HANDLE=true`). Returns the shutdown the
 * signal starts, for tests.
 */
export const installRuntimeShutdown = ({
  run,
  exit,
  budget,
  signals = ["SIGTERM", "SIGINT"],
}: RuntimeShutdownInstallation): (() => Promise<void>) => {
  const lifecycle = runtimeLifecycle();
  if (!lifecycle.tracksPending) trackHttpRequests();
  lifecycle.tracksPending = true;
  const shutdown = () => {
    lifecycle.shutdown ??= run(shutdownRuntime(budget)).then(
      () => exit(0),
      () => exit(1)
    );
    return lifecycle.shutdown;
  };
  for (const signal of signals) process.once(signal, shutdown);
  return shutdown;
};
