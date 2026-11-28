import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import {
  isLockedStackAction,
  lockedStackActions,
  lockedStackInvocation,
} from "../scripts/sandbox-locked-stack-actions";
import { sandboxConfig } from "./config/stack-config.test-utils";
import { alchemyStackCommand } from "./release/alchemy-service-apply";

/**
 * Every Alchemy command line this package runs, parsed by the installed
 * Alchemy CLI itself. The entrypoint is a stub that exits with a sentinel
 * code as soon as Alchemy imports it, so a command line the CLI accepts
 * reaches the import and nothing touches a cloud or a state store; one it
 * rejects (an unknown flag, a positional the command has no slot for)
 * exits 1 with its usage first.
 */

const accepted = 97;

const alchemyCommandLines = (): ReadonlyArray<{
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}> => {
  const locked = Object.keys(lockedStackActions)
    .filter(isLockedStackAction)
    .flatMap((action) =>
      lockedStackActions[action].program === "alchemy"
        ? [{ name: action, ...lockedStackInvocation(action, "sandbox") }]
        : []
    );
  const writer = Redacted.make("contract-writer-token");
  const release = (["deploy", "plan"] as const).flatMap((action) => {
    const command = alchemyStackCommand(sandboxConfig, {
      action,
      generation: null,
      writer,
    });
    return command._tag === "StandardCommand"
      ? [
          {
            name: `release ${action}`,
            command: command.command,
            args: command.args.map((arg) =>
              Redacted.isRedacted(arg) ? Redacted.value(arg) : arg
            ),
          },
        ]
      : [];
  });
  return [...locked, ...release];
};

const runAlchemy = (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>
) => {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: {
      HOME: cwd,
      PATH: process.env.PATH ?? "",
      CI: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

describe("the installed Alchemy CLI", () => {
  test("accepts every command line the release and the proof run", () => {
    const cwd = mkdtempSync(join(tmpdir(), "alchemy-cli-contract-"));
    try {
      writeFileSync(
        join(cwd, "alchemy.run.ts"),
        `process.exit(${accepted});\n`
      );
      const lines = alchemyCommandLines();
      expect(lines.map(({ name }) => name).sort()).toEqual([
        "destroy",
        "drift",
        "release deploy",
        "release plan",
        "repair",
      ]);
      for (const { name, command, args } of lines) {
        const { exitCode, output } = runAlchemy(cwd, command, args);
        expect({
          name,
          exitCode,
          output: exitCode === accepted ? "" : output,
        }).toEqual({ name, exitCode: accepted, output: "" });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects the entrypoint as a positional argument to drift", () => {
    const cwd = mkdtempSync(join(tmpdir(), "alchemy-cli-contract-"));
    try {
      writeFileSync(
        join(cwd, "alchemy.run.ts"),
        `process.exit(${accepted});\n`
      );
      const { command } = lockedStackInvocation("drift", "sandbox");
      const { exitCode, output } = runAlchemy(cwd, command, [
        "drift",
        "alchemy.run.ts",
        "--stage",
        "sandbox",
        "--no-input",
      ]);
      expect(exitCode).toBe(1);
      expect(output).toContain(
        'Unexpected positional argument: "alchemy.run.ts"'
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
