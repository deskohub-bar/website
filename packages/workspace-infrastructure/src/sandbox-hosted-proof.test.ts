import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  isLockedStackAction,
  lockedStackActions,
  lockedStackInvocation,
} from "../scripts/sandbox-locked-stack-actions";
import {
  sandboxProofBudget,
  sandboxProofStackConfig,
  sandboxProofStackConfigInput,
} from "../scripts/sandbox-stack-config";
import { decodeWorkspaceStackConfig } from "./config/stack-config";

const workflowFile = new URL(
  "../../../.github/workflows/workspace-gcp-sandbox-smoke.yml",
  import.meta.url
);
const runner = new URL("../scripts/sandbox-hosted-proof.sh", import.meta.url)
  .pathname;
const packageRoot = new URL("..", import.meta.url).pathname;

const StringRecord = Schema.Record(Schema.String, Schema.String);
const Step = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(StringRecord),
  with: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
    )
  ),
  "timeout-minutes": Schema.optionalKey(Schema.Finite),
});
type Step = typeof Step.Type;
const Workflow = Schema.Struct({
  on: Schema.Struct({
    workflow_dispatch: Schema.Struct({
      inputs: Schema.Record(
        Schema.String,
        Schema.Struct({
          type: Schema.String,
          default: Schema.String,
          options: Schema.Array(Schema.String),
        })
      ),
    }),
  }),
  concurrency: Schema.Record(Schema.String, Schema.Unknown),
  env: StringRecord,
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.Array(Step),
      "timeout-minutes": Schema.String,
    })
  ),
});

const workflowText = await Bun.file(workflowFile).text();
const workflow = Schema.decodeUnknownSync(Workflow)(
  Bun.YAML.parse(workflowText)
);
const steps = workflow.jobs.smoke?.steps ?? [];
const runnerScript = readFileSync(runner, "utf8");

const expression = (body: string) => ["${{", body, "}}"].join(" ");
const phaseOf = (step: Step) =>
  step.run?.match(/^bash "\$SANDBOX_PROOF_RUNNER" ([a-z0-9-]+)$/)?.[1];
const phaseSteps = steps.flatMap((step) => {
  const phase = phaseOf(step);
  return phase === undefined ? [] : [{ phase, step }];
});
const stepFor = (phase: string) =>
  phaseSteps.find((entry) => entry.phase === phase)?.step;
const indexOf = (predicate: (step: Step) => boolean) =>
  steps.findIndex(predicate);

const proofPhases = [
  "baseline-inventory",
  "foundation",
  "images",
  "deliver-v1",
  "private-access",
  "rpc-probe",
  "worker-probe",
  "deliver-v2",
  "drift",
  "interrupt-recover",
  "state-snapshot-restore",
  "restore-v1",
  "telemetry-privacy",
];
const teardownPhases = ["stack-destroy", "post-destroy-inventory"];
const teardownCondition =
  "always() && inputs.mode != 'read-only' && steps.preflight.outcome == 'success'";

/** Fake CLIs that record any call, so a dry run proves it touched nothing. */
const withFakeTools = <A>(run: (env: Record<string, string>) => A) => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-proof-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls.log");
  for (const tool of ["gcloud", "docker", "curl", "setsid"]) {
    const path = join(bin, tool);
    writeFileSync(
      path,
      `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 99\n`
    );
    chmodSync(path, 0o755);
  }
  try {
    return run({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SANDBOX_PROOF_DIR: join(dir, "proof"),
      CALLS_LOG: calls,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runRunner = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {}
) => {
  const result = Bun.spawnSync(["bash", runner, ...args], {
    cwd: packageRoot,
    env: { HOME: process.env.HOME ?? "/tmp", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

const dryRun = (alias: string) =>
  withFakeTools((env) => {
    const result = runRunner(["--dry-run", alias], env);
    let calls = "";
    try {
      calls = readFileSync(env.CALLS_LOG ?? "", "utf8");
    } catch {
      calls = "";
    }
    return { ...result, calls };
  });

const phasesIn = (output: string) =>
  [...output.matchAll(/^== phase: ([a-z0-9-]+)$/gm)].map((match) => match[1]);

const expectInOrder = (output: string, fragments: ReadonlyArray<string>) => {
  let from = 0;
  for (const fragment of fragments) {
    const at = output.indexOf(fragment, from);
    expect({ fragment, found: at >= 0 }).toEqual({ fragment, found: true });
    from = at + fragment.length;
  }
};

describe("sandbox workflow modes", () => {
  test("defaults to read-only and offers only the three modes", () => {
    const mode = workflow.on.workflow_dispatch.inputs.mode;
    expect(mode?.type).toBe("choice");
    expect(mode?.default).toBe("read-only");
    expect(mode?.options).toEqual([
      "read-only",
      "hosted-proof",
      "cleanup-only",
    ]);
  });

  test("serializes every sandbox run and never cancels one in progress", () => {
    expect(workflow.concurrency).toEqual({
      group: "workspace-gcp-sandbox",
      "cancel-in-progress": false,
    });
  });

  test("pins the approved sandbox identifiers", () => {
    expect(workflow.env).toMatchObject({
      SANDBOX_EXPECTED_PROJECT_ID: "deskohub-workspace-sandbox",
      SANDBOX_EXPECTED_PROJECT_NUMBER: "759037106024",
      SANDBOX_EXPECTED_STATE_BUCKET:
        "deskohub-workspace-sandbox-workspace-state",
      SANDBOX_REGION: "europe-west1",
    });
  });

  test("guards mutating modes before any credential is minted", () => {
    const guard = indexOf((step) => step.id === "guard");
    const auth = indexOf((step) => step.id === "auth");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(auth);
    expect(steps[guard]?.if).toBe("inputs.mode != 'read-only'");
  });

  test("leaves the token's expiry to the runner, never an estimate", () => {
    // The runner reads each token's remaining lifetime from tokeninfo.
    expect(workflowText).not.toContain("GOOGLE_ACCESS_TOKEN_EXPIRES_AT");
  });

  test("sets up no Terraform: Alchemy owns the stack", () => {
    expect(
      steps.filter(
        (step) =>
          step.uses?.startsWith("hashicorp/") ||
          /\bterraform\b/.test(step.run ?? "")
      )
    ).toEqual([]);
  });

  test("runs no mutating phase in read-only mode", () => {
    for (const { phase, step } of phaseSteps) {
      if (phase === "readonly-inventory") {
        expect(step.if).toBeUndefined();
      } else {
        expect(step.if ?? "").toMatch(
          /inputs\.mode (!= 'read-only'|== 'hosted-proof')/
        );
      }
    }
  });

  test("gives Alchemy an access token while gcloud keeps the credentials file", () => {
    const authSteps = steps.filter((step) =>
      step.uses?.startsWith("google-github-actions/auth@")
    );
    expect(authSteps.map((step) => step.with?.token_format)).toEqual([
      undefined,
      "access_token",
      "id_token",
      "id_token",
    ]);
    const alchemy = authSteps[1];
    expect(alchemy?.id).toBe("alchemy-auth");
    expect(alchemy?.with).toMatchObject({
      token_format: "access_token",
      access_token_lifetime: "3600s",
      create_credentials_file: false,
    });
    for (const phase of [
      "preflight",
      ...proofPhases.slice(1),
      "stack-destroy",
    ]) {
      expect(stepFor(phase)?.env?.GOOGLE_ACCESS_TOKEN).toBe(
        expression("steps.alchemy-auth.outputs.access_token")
      );
    }
  });

  test("mints a fresh workspace-api ID token for each step that calls it", () => {
    const deliver = indexOf((step) => phaseOf(step) === "deliver-v1");
    expect(steps[deliver]?.id).toBe("deliver-v1");
    const callers = [
      ["rpc-probe", "api-id-token"],
      ["restore-v1", "api-id-token-restore"],
    ] as const;
    for (const [phase, id] of callers) {
      const mint = indexOf((step) => step.id === id);
      const caller = indexOf((step) => phaseOf(step) === phase);
      expect({ id, after: mint > deliver }).toEqual({ id, after: true });
      // Minted right before its caller, so the hour starts there.
      expect({ id, next: steps[mint + 1] === steps[caller] }).toEqual({
        id,
        next: true,
      });
      expect(steps[mint]?.if).toBe("inputs.mode == 'hosted-proof'");
      expect(steps[mint]?.with).toMatchObject({
        service_account: expression("vars.GCP_SANDBOX_DEPLOY_SA"),
        token_format: "id_token",
        id_token_audience: expression("steps.deliver-v1.outputs.api_url"),
        create_credentials_file: false,
      });
      expect(steps[caller]?.env?.SANDBOX_API_ID_TOKEN).toBe(
        expression(`steps.${id}.outputs.id_token`)
      );
    }
    // No other step sees an ID token.
    expect(
      steps.filter((step) => step.env?.SANDBOX_API_ID_TOKEN !== undefined)
    ).toHaveLength(callers.length);
  });

  test("wires no collector or OTLP export into the proof", () => {
    for (const text of [workflowText, runnerScript]) {
      expect(text).not.toMatch(
        /WORKSPACE_OTLP_ENDPOINT|WORKSPACE_TRACE_PROJECT_ID|collector|workspace-web\b/
      );
    }
  });

  test("bills quota to the sandbox on every billing command", () => {
    const billing = steps.find((step) => step.run?.includes("gcloud billing"));
    expect(billing?.env?.CLOUDSDK_BILLING_QUOTA_PROJECT).toBe(
      expression("vars.GCP_SANDBOX_PROJECT_ID")
    );
    const runnerBillingCalls = runnerScript.match(/gcloud billing/g) ?? [];
    expect(runnerBillingCalls).toHaveLength(2);
    expect(runnerScript).toContain(
      'CLOUDSDK_BILLING_QUOTA_PROJECT="$project_id" gcloud billing "$@"'
    );
  });

  test("runs the proof phases in order, then always tears down", () => {
    expect(phaseSteps.map((entry) => entry.phase)).toEqual([
      "guard",
      "readonly-inventory",
      "preflight",
      ...proofPhases,
      ...teardownPhases,
    ]);
    for (const phase of proofPhases) {
      expect(stepFor(phase)?.if).toBe("inputs.mode == 'hosted-proof'");
    }
    for (const phase of teardownPhases) {
      expect(stepFor(phase)?.if).toBe(teardownCondition);
    }
    const upload = steps.at(-1);
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload?.if).toContain("always()");
  });

  test("gives each mutating mode a job limit above its step ceilings", () => {
    const jobLimit = workflow.jobs.smoke?.["timeout-minutes"] ?? "";
    for (const mode of ["hosted-proof", "cleanup-only"]) {
      const limit = Number(
        jobLimit.match(new RegExp(`inputs\\.mode == '${mode}' && (\\d+)`))?.[1]
      );
      const ceilings = phaseSteps
        .filter(
          ({ step }) =>
            step.if === teardownCondition ||
            (mode === "hosted-proof" &&
              step.if === "inputs.mode == 'hosted-proof'")
        )
        .reduce((total, { step }) => total + (step["timeout-minutes"] ?? 0), 0);
      expect(ceilings).toBeGreaterThan(0);
      // Unbounded setup steps (checkout, auth, tool install) need headroom.
      expect(limit - ceilings).toBeGreaterThanOrEqual(15);
    }
  });
});

describe("sandbox proof runner", () => {
  test("refuses mutating modes off main or against another project", () => {
    withFakeTools((env) => {
      const base = {
        ...env,
        SANDBOX_PROOF_MODE: "hosted-proof",
        GITHUB_REF: "refs/heads/main",
        GCP_SANDBOX_PROJECT_ID: "deskohub-workspace-sandbox",
        GCP_SANDBOX_STATE_BUCKET: "deskohub-workspace-sandbox-workspace-state",
        GCP_SANDBOX_DEPLOY_SA: [
          "workspace-deployer",
          "deskohub-workspace-sandbox.iam.gserviceaccount.com",
        ].join("@"),
        SANDBOX_EXPECTED_PROJECT_ID: "deskohub-workspace-sandbox",
        SANDBOX_EXPECTED_PROJECT_NUMBER: "759037106024",
        SANDBOX_EXPECTED_STATE_BUCKET:
          "deskohub-workspace-sandbox-workspace-state",
        SANDBOX_REGION: "europe-west1",
      };
      expect(runRunner(["guard"], base).exitCode).toBe(0);
      for (const override of [
        { GITHUB_REF: "refs/heads/feature" },
        { SANDBOX_PROOF_MODE: "read-only" },
        { GCP_SANDBOX_PROJECT_ID: "deskohub-workspace-preview" },
        {
          GCP_SANDBOX_STATE_BUCKET:
            "deskohub-workspace-preview-workspace-state",
        },
        { SANDBOX_REGION: "europe-west3" },
      ]) {
        expect(runRunner(["guard"], { ...base, ...override }).exitCode).toBe(1);
      }
    });
  });

  test("dry-runs the full hosted proof in order without touching Google Cloud", () => {
    const { exitCode, output, calls } = dryRun("hosted-proof");
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(calls).toBe("");
    expect(phasesIn(output)).toEqual([...proofPhases, ...teardownPhases]);
    expectInOrder(output, [
      "gcloud run services list",
      "gcloud storage cp",
      "gs://deskohub-workspace-sandbox-workspace-state/sandbox-proof/run.env",
      "bun scripts/sandbox-stack-config.ts",
      "bun run release deploy",
      "archive --format=tar",
      "docker buildx build",
      "apps/deskohub-workspace-api/Dockerfile --target sandbox",
      "PROBE_BUILD_VERSION=v1",
      "PROBE_BUILD_VERSION=v2",
      "PROBE_BUILD_VERSION=v3",
      "bun run release deliver --sha",
      "bun run release status",
      "bun run release plan",
      "gcloud run services describe workspace-api --project=deskohub-workspace-sandbox --region=europe-west1 --format=json",
      "gcloud run services describe workspace-scheduler-worker --project=deskohub-workspace-sandbox --region=europe-west1 --format=json",
      "/health",
      "/rpc",
      "gcloud run services get-iam-policy workspace-api",
      "Authorization:\\ Bearer\\ garbage",
      "bun scripts/sandbox-rpc-probe.ts --url https://workspace-api-",
      "--expect-version v1",
      "--email-preferences",
      "gcloud tasks queues describe workspace-paid-fulfillment-r0-1",
      "gcloud tasks create-http-task --queue=workspace-paid-fulfillment-r0-1",
      "gcloud logging read",
      "gcloud scheduler jobs describe workspace-proof-tick-r0-1",
      "gcloud scheduler jobs resume workspace-proof-tick-r0-1",
      "gcloud scheduler jobs run workspace-proof-tick-r0-1",
      "gcloud logging read",
      "gcloud scheduler jobs pause workspace-proof-tick-r0-1",
      "bun run release deliver --sha",
      "gcloud artifacts repositories update workspace",
      "bun scripts/sandbox-locked-stack.ts drift",
      "bun scripts/sandbox-locked-stack.ts repair",
      "bun run release deploy",
      "SANDBOX_PROOF_INTERRUPT_TOKEN=",
      "bun run release deliver --sha",
      "sleep 65",
      "bun run release unlock --holder",
      "sleep 65",
      "bun scripts/sandbox-locked-stack.ts state-snapshot",
      "bun run release restore --release-id",
      "bun scripts/sandbox-locked-stack.ts state-snapshot",
      "bun scripts/sandbox-locked-stack.ts state-restore",
      "bun run release deploy",
      "bun run release restore --release-id",
      "bun scripts/sandbox-rpc-probe.ts --url https://workspace-api-",
      "sleep 90",
      'log_id\\(\\"run.googleapis.com/requests\\"\\)',
      'gcloud logging read \\"<marker>\\" --project=deskohub-workspace-sandbox',
      "https://cloudtrace.googleapis.com/v1/projects/deskohub-workspace-sandbox/traces/",
      "https://cloudtrace.googleapis.com/v1/projects/deskohub-workspace-sandbox/traces\\?view=COMPLETE\\&pageSize=100",
      "bun scripts/sandbox-locked-stack.ts destroy",
      "gcloud storage rm gs://deskohub-workspace-sandbox-workspace-state/workspace-release-record.sandbox.json",
      "gcloud storage rm gs://deskohub-workspace-sandbox-workspace-state/sandbox-proof/run.env",
      "gcloud run services list",
      "CLOUDSDK_BILLING_QUOTA_PROJECT=deskohub-workspace-sandbox gcloud billing projects describe",
    ]);
    expect(output).not.toContain("::error::");
    // Outside GitHub Actions nothing shows the marker, not even a mask
    // command; every traced command shows it redacted.
    expect(output).not.toMatch(/sandbox-marker-[0-9a-f]/);
    expect(output).toContain("<marker>");
    expect(output).not.toContain("jsonPayload:");
    expect(output).not.toContain("textPayload:");
    expect(output).not.toContain("httpRequest.requestUrl:");
  });

  test("dry-runs cleanup-only as teardown and inventory alone", () => {
    const { exitCode, output, calls } = dryRun("cleanup-only");
    expect(exitCode).toBe(0);
    expect(calls).toBe("");
    expect(phasesIn(output)).toEqual(teardownPhases);
    expect(output).not.toContain("release deliver");
    expect(output).not.toContain("docker");
    expectInOrder(output, [
      "bun scripts/sandbox-locked-stack.ts destroy",
      "gcloud storage ls -r",
    ]);
  });

  test("runs Alchemy only through the release command or the lock holder", () => {
    expect(runnerScript).not.toMatch(/alchemy (deploy|destroy|plan|drift)/);
    expect(runnerScript).not.toMatch(/node_modules\/\.bin\/alchemy/);
  });
});

describe("sandbox proof stack config", () => {
  const identity = {
    projectId: "deskohub-workspace-sandbox",
    projectNumber: "759037106024",
    region: "europe-west1",
    stateBucket: "deskohub-workspace-sandbox-workspace-state",
  };

  test("decodes with the package schema under the approved budget", async () => {
    const config = await Effect.runPromise(
      decodeWorkspaceStackConfig(sandboxProofStackConfigInput(identity))
    );
    expect(config.stage).toBe("sandbox");
    expect(config.stage === "sandbox" && config.budget).toEqual(
      sandboxProofBudget
    );
    expect(config.secrets).toEqual([]);
    expect(config.schedulesEnabled).toBe(false);
    // IAM-private Cloud Run: no HTTP edge.
    expect("edge" in config).toBe(false);
    expect(
      JSON.parse(await Effect.runPromise(sandboxProofStackConfig(identity)))
    ).toMatchObject({ projectNumber: "759037106024", stage: "sandbox" });
  });
});

describe("writer-locked stack actions", () => {
  test("snapshot and restore state through the runner as the lock holder", () => {
    for (const [action, phase, mutates] of [
      ["state-snapshot", "state-snapshot-locked", false],
      ["state-restore", "state-restore-locked", true],
    ] as const) {
      const { command, args } = lockedStackInvocation(action, "sandbox");
      expect(command).toBe("bash");
      expect(args[0]).toEndWith("scripts/sandbox-hosted-proof.sh");
      expect(args.slice(1)).toEqual([phase]);
      expect(lockedStackActions[action].mutates).toBe(mutates);
    }
  });

  test("map to Alchemy commands for exactly the given stage", () => {
    const alchemyArgs = (action: "drift" | "repair" | "destroy") => {
      const { command, args } = lockedStackInvocation(action, "sandbox");
      expect(command).toEndWith("node_modules/.bin/alchemy");
      return args;
    };
    expect(alchemyArgs("drift")).toEqual([
      "drift",
      "--config",
      "alchemy.run.ts",
      "--stage",
      "sandbox",
      "--no-input",
    ]);
    expect(alchemyArgs("repair")).toEqual([
      "drift",
      "--config",
      "alchemy.run.ts",
      "--stage",
      "sandbox",
      "--repair",
      "--yes",
      "--no-input",
    ]);
    expect(alchemyArgs("destroy")).toEqual([
      "destroy",
      "alchemy.run.ts",
      "--stage",
      "sandbox",
      "--yes",
      "--no-input",
    ]);
    expect(lockedStackActions.drift).toMatchObject({
      operation: "plan",
      mutates: false,
    });
    // Its own operation lets it drain a stack a pre-rename record names.
    expect(lockedStackActions.destroy).toMatchObject({
      operation: "destroy",
      mutates: true,
    });
    expect(isLockedStackAction("destroy")).toBe(true);
    expect(isLockedStackAction("state-restore")).toBe(true);
    expect(isLockedStackAction("deploy")).toBe(false);
  });
});
