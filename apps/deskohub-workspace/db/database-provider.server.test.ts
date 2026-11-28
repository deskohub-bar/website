import { expect, test } from "bun:test";
import assert from "node:assert/strict";

const lifecycleKey = Symbol.for("@deskohub-workspace/runtime-lifecycle");

interface RegisteredHooks {
  readonly hooks: ReadonlyMap<
    string,
    { readonly stage: string; readonly run: () => Promise<unknown> }
  >;
}

test("closes both database pools last when a container shuts down", async () => {
  await import("./database-provider.server");
  const holder: typeof globalThis & { [lifecycleKey]?: RegisteredHooks } =
    globalThis;
  const lifecycle = holder[lifecycleKey];
  assert(lifecycle, "the runtime lifecycle registered shutdown hooks");
  const { hooks } = lifecycle;

  expect(hooks.get("database.auth-pool")?.stage).toBe("close");
  const workspacePool = hooks.get("database.workspace-pool");
  expect(workspacePool?.stage).toBe("close");
  // No run opened the Workspace pool, so closing it has nothing to end.
  await expect(workspacePool?.run()).resolves.toBeUndefined();
});
