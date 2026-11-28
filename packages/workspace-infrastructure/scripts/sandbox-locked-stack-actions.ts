import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The locked stack actions and the command lines they run, apart from the
 * runner in `sandbox-locked-stack.ts` so the proof's fakes can check them
 * without loading the release runtime.
 *
 * Stack commands the sandbox proof needs that the release command has no
 * verb for. Each runs under the stage's writer lock, like `release deploy`,
 * so the proof never becomes a second stack writer: Alchemy drift, repair
 * and destroy, and the runner's own snapshot and restore of the stack's
 * Alchemy state objects.
 */
export const lockedStackActions = {
  /**
   * Detect drift: exit 2 when found and left unrepaired, 0 when clean, 1
   * when the check itself failed. Changes nothing. `alchemy drift` takes
   * its entrypoint only through `--config`, never positionally.
   */
  drift: {
    operation: "plan",
    mutates: false,
    acceptedExitCodes: [0, 2],
    program: "alchemy",
    args: (stage: string) => [
      "drift",
      "--config",
      "alchemy.run.ts",
      "--stage",
      stage,
    ],
  },
  /** Repair detected drift back to the declarations. */
  repair: {
    operation: "deploy",
    mutates: true,
    acceptedExitCodes: [0],
    program: "alchemy",
    args: (stage: string) => [
      "drift",
      "--config",
      "alchemy.run.ts",
      "--stage",
      stage,
      "--repair",
      "--yes",
    ],
  },
  /** Destroy exactly this stage's stack. */
  destroy: {
    operation: "destroy",
    mutates: true,
    acceptedExitCodes: [0],
    program: "alchemy",
    args: (stage: string) => [
      "destroy",
      "alchemy.run.ts",
      "--stage",
      stage,
      "--yes",
    ],
  },
  /** Record one live generation and checksum per state object. */
  "state-snapshot": {
    operation: "plan",
    mutates: false,
    acceptedExitCodes: [0],
    program: "runner",
    args: () => ["state-snapshot-locked"],
  },
  /** Restore the recorded state generations and verify them live. */
  "state-restore": {
    operation: "deploy",
    mutates: true,
    acceptedExitCodes: [0],
    program: "runner",
    args: () => ["state-restore-locked"],
  },
} as const;

export type LockedStackAction = keyof typeof lockedStackActions;

export const isLockedStackAction = (
  value: string | undefined
): value is LockedStackAction =>
  value !== undefined && Object.hasOwn(lockedStackActions, value);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const alchemyCli = join(packageRoot, "node_modules", ".bin", "alchemy");
const proofRunner = join(packageRoot, "scripts", "sandbox-hosted-proof.sh");

/** The program, arguments and directory one locked action runs with. */
export const lockedStackInvocation = (
  action: LockedStackAction,
  stage: string
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
} => {
  const spec = lockedStackActions[action];
  return spec.program === "alchemy"
    ? {
        command: alchemyCli,
        args: [...spec.args(stage), "--no-input"],
        cwd: packageRoot,
      }
    : {
        command: "bash",
        args: [proofRunner, ...spec.args()],
        cwd: packageRoot,
      };
};
