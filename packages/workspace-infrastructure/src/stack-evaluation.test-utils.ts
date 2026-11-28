import { Providers } from "@alchemy.run/gcp";
import type { ResourceLike } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The providers a declaration names. Registration only looks them up on
 * deploy, so the collection is empty.
 */
const evaluationProviders = Layer.succeed(Providers, {
  kind: "ProviderCollection",
  get: () => undefined,
  providers: {},
});

/**
 * Evaluate a declaration against an empty in-memory stack. Registration
 * runs the real beta.87 constructors (and their logical-ID checks) without
 * providers, state or credentials.
 */
export const evaluate = async <A, E>(
  declaration: Effect.Effect<
    A,
    E,
    Stack | Layer.Success<typeof evaluationProviders>
  >
) => {
  const resources: Record<string, ResourceLike> = {};
  const registration = declaration.pipe(
    Effect.provide(evaluationProviders),
    Effect.provideService(Stack, {
      name: "DeskohubWorkspaceTest",
      stage: "sandbox",
      resources,
      bindings: {},
      actions: {},
    })
  );
  const exit = await Effect.runPromiseExit(registration);
  return { exit, resources };
};
