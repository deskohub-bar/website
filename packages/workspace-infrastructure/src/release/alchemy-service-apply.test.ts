import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Redacted from "effect/Redacted";
import {
  productionConfig,
  sandboxConfig,
} from "../config/stack-config.test-utils";
import {
  alchemyStackCommand,
  commandServiceApply,
  releaseApplyGenerationVariable,
  releaseWriterVariable,
} from "./alchemy-service-apply";
import {
  ReleaseServiceApply,
  type StackApplyRequest,
} from "./release-platform";

const writer = Redacted.make("probe-writer-token");

const fenced = (generation: number): StackApplyRequest => ({
  action: "deploy",
  generation,
  writer,
});

const applyWith = (
  command: (request: StackApplyRequest) => ChildProcess.Command,
  request: StackApplyRequest
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const platform = yield* ReleaseServiceApply;
      yield* platform.apply(request);
    }).pipe(
      Effect.provide(
        commandServiceApply(command).pipe(Layer.provide(BunServices.layer))
      )
    )
  );

/**
 * Runs a script with exactly the environment the stack command would get,
 * so the test sees what the child process sees.
 */
const probe = (script: string) => (request: StackApplyRequest) =>
  ChildProcess.make(process.execPath, ["-e", script], {
    ...alchemyStackCommand(sandboxConfig, request).options,
    stdout: "ignore",
    stderr: "ignore",
  });

/** Exits 0 only when the apply received the token and generation 7. */
const generationProbe = probe(
  `process.exit(process.env.${releaseApplyGenerationVariable} === "7" && process.env.${releaseWriterVariable} === "probe-writer-token" ? 0 : 3)`
);

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure");
  }
  const reason = exit.cause.reasons[0];
  return reason?._tag === "Fail" ? reason.error : reason;
};

describe("alchemy service apply", () => {
  test("runs the installed CLI on the config's own stage", () => {
    for (const config of [sandboxConfig, productionConfig]) {
      const deploy = alchemyStackCommand(config, fenced(12));
      const plan = alchemyStackCommand(config, {
        action: "plan",
        generation: null,
        writer,
      });
      for (const command of [deploy, plan]) {
        expect(command._tag).toBe("StandardCommand");
        if (command._tag !== "StandardCommand") {
          continue;
        }
        expect(
          command.command.endsWith(
            "workspace-infrastructure/node_modules/.bin/alchemy"
          )
        ).toBe(true);
        // The stack config and credentials come from the caller's environment.
        expect(command.options.extendEnv).toBe(true);
        expect(command.options.cwd?.endsWith("workspace-infrastructure/")).toBe(
          true
        );
      }
      if (
        deploy._tag === "StandardCommand" &&
        plan._tag === "StandardCommand"
      ) {
        expect(deploy.args).toEqual([
          "deploy",
          "alchemy.run.ts",
          "--stage",
          config.stage,
          "--yes",
          "--no-input",
        ]);
        expect(plan.args).toEqual([
          "plan",
          "alchemy.run.ts",
          "--stage",
          config.stage,
          "--no-input",
        ]);
      }
    }
  });

  test("a zero exit applies and any other exit leaves the outcome unknown", async () => {
    expect(Exit.isSuccess(await applyWith(generationProbe, fenced(7)))).toBe(
      true
    );
    expect(
      failureOf(await applyWith(generationProbe, fenced(8)))
    ).toMatchObject({
      _tag: "ReleaseServiceApplyFailed",
      generation: 8,
      outcome: "unknown",
      reason: "The apply exited with code 3",
    });
  });

  test("a plain run never inherits a generation fence", async () => {
    const inherited = process.env[releaseApplyGenerationVariable];
    process.env[releaseApplyGenerationVariable] = "7";
    try {
      const plain = await applyWith(
        probe(
          `process.exit(process.env.${releaseApplyGenerationVariable} === undefined ? 0 : 3)`
        ),
        { action: "deploy", generation: null, writer }
      );
      expect(Exit.isSuccess(plain)).toBe(true);
    } finally {
      if (inherited === undefined) {
        delete process.env[releaseApplyGenerationVariable];
      } else {
        process.env[releaseApplyGenerationVariable] = inherited;
      }
    }
  });

  test("a command that cannot start changed nothing", async () => {
    const missing = await applyWith(
      () =>
        ChildProcess.make("workspace-release-missing-program", [], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      fenced(4)
    );
    expect(failureOf(missing)).toMatchObject({
      _tag: "ReleaseServiceApplyFailed",
      generation: 4,
      outcome: "not-started",
    });
  });
});
