import {
  type Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";

/**
 * Returns a function that provides `layer` to an Effect through a
 * `ManagedRuntime`, so the layer is built on first use and reused by every
 * later run.
 *
 * Runs provide the runtime's context rather than calling
 * `runtime.runPromise`, so `mapError` still sees layer build failures.
 *
 * The runtime is never disposed: serverless processes end without a shutdown
 * hook, so a shared layer must not rely on finalizers. A failed build stays
 * cached.
 */
export const makeSharedLayerProvider = <R, LE>(
  layer: Layer.Layer<R, LE, never>,
  memoMap?: Layer.MemoMap
) => {
  const runtime = ManagedRuntime.make(layer, { memoMap });

  return <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | LE> =>
    Effect.flatMap(runtime.contextEffect, (context) =>
      Effect.provideContext(
        // Layers a run provides itself memoize into the current memo map. A
        // per-run fork reuses the shared layers but keeps new ones per run, as
        // a per-run `Effect.provide(layer)` did, so concurrent requests never
        // share them.
        Effect.provideService(
          effect,
          Layer.CurrentMemoMap,
          Layer.forkMemoMapUnsafe(runtime.memoMap)
        ),
        context
      )
    );
};

/**
 * `layer` built at most once per process, by the first run that uses it, and
 * shared by every later run, such as a provider client and its token cache.
 * Wherever a run provides it, the run gets the process instance.
 *
 * - Share only capabilities that read nothing from a request and need no
 *   finalizer. The build's scope is never closed, since serverless processes
 *   end without a shutdown hook, and anything the build captured from the
 *   first request (headers, request context, an abort signal) would serve
 *   every later one. A capability that holds connections a long-lived
 *   process must release on shutdown uses `shareUntilShutdown`.
 * - Only a successful build is kept. A build that fails or is interrupted
 *   fails the runs waiting for it and is dropped, so the next run builds
 *   again. A runtime's own layer (`NextEffect.make`) instead keeps a failed
 *   build.
 * - The build runs in the first run's fiber, so its logs and spans belong to
 *   that run.
 * - Each shared layer memoizes the layers it is built from by itself. A run
 *   that provides one of those layers directly builds its own, and two shared
 *   layers share only what they both are built from as a shared layer.
 */
export const shareAcrossRequests = <A, E>(
  layer: Layer.Layer<A, E, never>
): Layer.Layer<A, E> => shareUntilShutdown(layer).layer;

/** A layer shared across requests, and the shutdown that releases it. */
export interface SharedUntilShutdown<A, E> {
  /** Provides the process instance, as `shareAcrossRequests` does. */
  readonly layer: Layer.Layer<A, E>;
  /**
   * Closes the build's scope, running its finalizers, such as a pool's
   * `end()`, and settles once they have. A process that shuts itself down,
   * such as a container on SIGTERM, calls it once its requests have drained.
   * It is final: a run that provides the layer afterwards dies instead of
   * building it again. Closing again, or a layer no run built, does nothing.
   */
  readonly close: () => Promise<void>;
}

/**
 * `shareAcrossRequests` for a capability with finalizers, such as a
 * connection pool: the process closes it on shutdown. On a host that never
 * shuts the process down itself, such as Vercel, `close` never runs and the
 * layer behaves exactly like `shareAcrossRequests`.
 */
export const shareUntilShutdown = <A, E>(
  layer: Layer.Layer<A, E, never>
): SharedUntilShutdown<A, E> => {
  const scope = Scope.makeUnsafe();
  // The current build, or the successful one. Runs reuse its context, so a
  // run registers nothing on the process scope.
  let shared: Deferred.Deferred<Context.Context<A>, E> | undefined;

  // Uninterruptible until the attempt's exit handler is installed, so an
  // interruption can never leave a published build that nothing settles.
  const build = Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      if (scope.state._tag === "Closed") {
        return Effect.die(new Error("A shared layer was used after shutdown."));
      }
      if (shared) return restore(Deferred.await(shared));
      const deferred = Deferred.makeUnsafe<Context.Context<A>, E>();
      shared = deferred;
      // Each attempt builds in its own scope, so a failed one releases what
      // it acquired and leaves the next run to build again, and with its own
      // memo map, so it never reuses a layer the first run built for itself.
      const attemptScope = Scope.forkUnsafe(scope);
      return restore(
        Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), attemptScope)
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Deferred.done(deferred, exit)
            : Effect.sync(() => {
                if (shared === deferred) shared = undefined;
              }).pipe(
                Effect.andThen(Scope.close(attemptScope, exit)),
                Effect.andThen(Deferred.done(deferred, exit))
              )
        )
      );
    })
  );

  return {
    layer: Layer.fromBuild(() => build),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};
