import { describe, expect, test } from "bun:test";

const commandLine = new URL("./command-line.ts", import.meta.url).pathname;

/** Run a Bun program that imports the command-line helpers. */
const runProgram = (body: string) => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stdio from "effect/Stdio";
import { exitCodeWithOutputOnStderr, runCommandLine } from ${JSON.stringify(commandLine)};
${body}`,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

// What Alchemy's GCP auth logs while its layer is built.
const alchemyLog =
  "GCP: using environment variables (GOOGLE_ACCESS_TOKEN, GOOGLE_PROJECT_ID).";

describe("command-line output", () => {
  test("keeps every log off stdout, layer construction included", () => {
    const { exitCode, stdout, stderr } = runProgram(`
const Auth = Layer.effectDiscard(Effect.logInfo(${JSON.stringify(alchemyLog)}));
runCommandLine(
  Effect.logWarning("about to print").pipe(
    Effect.andThen(Console.log(JSON.stringify({ record: { writer: null } }, null, 2))),
    Effect.provide(Auth)
  )
);`);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ record: { writer: null } });
    expect(stderr).toContain(`INFO (#`);
    expect(stderr).toContain(alchemyLog);
    expect(stderr).toContain("about to print");
  });

  test("reports a failed command on stderr, never stdout, and exits nonzero", () => {
    const { exitCode, stdout, stderr } = runProgram(`
runCommandLine(Effect.fail(new Error("WorkspaceStackConfigInvalid: no stage")));`);
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("WorkspaceStackConfigInvalid: no stage");
    // Reported once, not again by the runtime.
    expect(stderr.split("WorkspaceStackConfigInvalid: no stage").length).toBe(
      2
    );
  });

  test("forwards a child's stdout to stderr and returns its exit code", () => {
    const { exitCode, stdout, stderr } = runProgram(`
runCommandLine(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const stdio = yield* Stdio.Stdio;
    const code = yield* spawner
      .spawn(
        ChildProcess.make(process.execPath, ["-e", "console.log('child progress'); process.exit(3)"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        })
      )
      .pipe(
        Effect.flatMap((handle) => exitCodeWithOutputOnStderr(handle, stdio)),
        Effect.scoped
      );
    yield* Console.log(JSON.stringify({ code }));
  })
);`);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ code: 3 });
    expect(stderr).toContain("child progress");
  });
});
