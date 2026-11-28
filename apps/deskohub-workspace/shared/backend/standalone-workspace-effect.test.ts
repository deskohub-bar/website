import { describe, expect, test } from "bun:test";
import { Effect, Logger, References } from "effect";
import {
  runStandaloneWorkspaceEffect,
  setStandaloneWorkspaceObservability,
} from "./standalone-workspace-effect";

describe("runStandaloneWorkspaceEffect", () => {
  test("logs through the observability the process set before its first run", async () => {
    const rows: { message: unknown; operation: unknown }[] = [];
    setStandaloneWorkspaceObservability(
      Logger.layer([
        Logger.make(({ fiber, message }) => {
          rows.push({
            message,
            operation: fiber.getRef(References.CurrentLogAnnotations).operation,
          });
        }),
      ])
    );

    try {
      await runStandaloneWorkspaceEffect("test.standalone")(
        Effect.logInfo("standalone run")
      );
    } finally {
      Reflect.deleteProperty(
        globalThis,
        Symbol.for("@deskohub-workspace/standalone-observability")
      );
    }

    expect(rows).toEqual([
      { message: ["standalone run"], operation: "test.standalone" },
    ]);
  });
});
