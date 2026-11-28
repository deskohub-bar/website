import { Context, Effect, Layer } from "effect";
import { providePerRequest } from "./provide-per-request";

/** Runs `use` on the operation's own instance of the service. */
export type OperationRun<S> = <A, E>(
  use: (instance: S) => Effect.Effect<A, E>
) => Effect.Effect<A, E>;

/**
 * `service` with every operation run on its own instance of
 * `implementation`, built for that operation with `providePerRequest` over
 * what its run or request already built. `operations` forwards each of them
 * through `run`.
 *
 * Use it for a service an HTTP API builds for the whole handler whose
 * implementation keeps state for its request, such as a release decision or
 * a consent cache: the handler lives for the process, so a plain
 * implementation would hand that state to every later request.
 *
 * `implementation` holds only that request state. What it requires, such as
 * provider clients and repositories, is built once with the returned Layer,
 * by whoever provides it, and every operation's instance takes that one.
 */
export const servicePerOperation = <I, S, RIn = never>(
  service: Context.Key<I, S>,
  operations: (run: OperationRun<S>) => S,
  implementation: Layer.Layer<I, never, RIn>
): Layer.Layer<I, never, RIn> =>
  Layer.effect(
    service,
    Effect.map(Effect.context<RIn>(), (shared) =>
      operations((use) =>
        Effect.flatMap(Effect.service(service), use).pipe(
          providePerRequest(implementation),
          // The operation's own context wins, so `shared` adds only the
          // requirements built with this Layer, never the span or request
          // context that build ran in.
          Effect.updateContext((operation: Context.Context<never>) =>
            Context.merge(shared, operation)
          )
        )
      )
    )
  );
