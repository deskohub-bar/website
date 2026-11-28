import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { sandboxServiceAccount } from "./config/stack-config.test-utils";

const workflowFile = new URL(
  "../../../.github/workflows/workspace-gcp-sandbox-smoke.yml",
  import.meta.url
);
const bootstrapScript = new URL(
  "../scripts/bootstrap-sandbox-wif.sh",
  import.meta.url
).pathname;

const StringRecord = Schema.Record(Schema.String, Schema.String);
const WorkflowStep = Schema.Struct({
  if: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
    )
  ),
  run: Schema.optionalKey(Schema.String),
});
const Workflow = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Unknown),
  permissions: StringRecord,
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      environment: Schema.String,
      permissions: StringRecord,
      env: StringRecord,
      steps: Schema.Array(WorkflowStep),
    })
  ),
});

const workflow = Schema.decodeUnknownSync(Workflow)(
  Bun.YAML.parse(await Bun.file(workflowFile).text())
);

const runBootstrap = (...args: ReadonlyArray<string>) =>
  Bun.spawnSync(["bash", bootstrapScript, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });

const dryRunArgs = [
  "--dry-run",
  "--project-id",
  "deskohub-ws-sandbox",
  "--project-number",
  "123456789012",
  "--github-repository",
  "example-owner/example-repo",
  "--github-owner-id",
  "1001",
  "--github-repository-id",
  "2002",
  "--max-spend",
  "200",
  "--currency",
  "EUR",
  "--teardown-date",
  "2026-12-31",
  "--vercel-team-slug",
  "example-team",
  "--vercel-project",
  "example-frontend",
  "--vercel-owner-id",
  "team_example1001",
  "--vercel-project-id",
  "prj_example2002",
];

const vercelPool =
  "projects/123456789012/locations/global/workloadIdentityPools/workspace-vercel";

describe("sandbox smoke workflow", () => {
  test("runs only on manual dispatch", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("grants id-token only to the smoke job in the sandbox environment", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["smoke"]);
    const job = workflow.jobs.smoke;
    expect(job?.environment).toBe("workspace-gcp-sandbox");
    expect(job?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(Object.keys(job?.env ?? {})).toEqual([
      "GCP_SANDBOX_PROJECT_ID",
      "GCP_SANDBOX_WIF_PROVIDER",
      "GCP_SANDBOX_DEPLOY_SA",
      "GCP_SANDBOX_STATE_BUCKET",
    ]);
  });

  test("pins every action by full commit SHA and authenticates through federation", () => {
    const steps = workflow.jobs.smoke?.steps ?? [];
    const actions = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const auth = steps.find((step) =>
      step.uses?.startsWith("google-github-actions/auth@")
    );
    const variable = (name: string) => ["${{", `vars.${name}`, "}}"].join(" ");
    expect(auth?.with).toEqual({
      project_id: variable("GCP_SANDBOX_PROJECT_ID"),
      workload_identity_provider: variable("GCP_SANDBOX_WIF_PROVIDER"),
      service_account: variable("GCP_SANDBOX_DEPLOY_SA"),
    });
  });

  test("runs read-only checks without expanding expressions in scripts", () => {
    const allSteps = workflow.jobs.smoke?.steps ?? [];
    expect(
      allSteps.flatMap((step) => (step.run ? [step.run] : [])).join("\n")
    ).not.toContain("${{");
    // The default read-only mode runs exactly the steps without a mode
    // condition; mutating phases carry one (sandbox-hosted-proof.test.ts).
    const readOnlySteps = allSteps.filter((step) => step.if === undefined);
    const scripts = readOnlySteps
      .flatMap((step) => (step.run ? [step.run] : []))
      .join("\n");
    expect(
      [...scripts.matchAll(/"\$SANDBOX_PROOF_RUNNER" ([a-z0-9-]+)/g)].map(
        (match) => match[1]
      )
    ).toEqual(["readonly-inventory"]);
    for (const check of [
      "gcloud projects describe",
      "gcloud billing projects describe",
      "gcloud storage buckets describe",
    ]) {
      expect(scripts).toContain(check);
    }
    const gcloudCommands = [
      ...scripts.matchAll(/gcloud ([a-z -]+?)(?= ["-])/g),
    ].map((match) => match[1]);
    expect(new Set(gcloudCommands)).toEqual(
      new Set([
        "auth list",
        "projects describe",
        "billing projects describe",
        "storage buckets describe",
        "storage ls",
      ])
    );
  });
});

/**
 * Run the script live against a stub `gcloud` that answers lookups from
 * the environment and records every call, so live-only guards can be
 * tested without Google Cloud.
 */
const runLiveBootstrap = (
  answers: {
    projectNumber: string;
    jwksJson?: string;
    jwksLookupFails?: boolean;
    /** `location<TAB>location_type`, as gcloud prints the state bucket's. */
    bucketLocation?: string;
    /** `key=value;key=value`, as gcloud prints the project's labels. */
    labels?: string;
    labelsLookupFails?: boolean;
    /** Quota refusals before `workspace-api` is created. */
    serviceAccountQuotaFailures?: number;
    /** `workspace-deployer` creation races another run that created it. */
    deployerAlreadyExists?: boolean;
    /** Provider names gcloud lists for the Vercel pool. */
    vercelProviders?: string;
    vercelJwksJson?: string;
    /** gcloud's error for every retired-binding removal, if any. */
    removeBindingError?: string;
    /** The deployer's project roles, one per line, as policy readback prints them. */
    deployerRoles?: string;
  },
  ...args: ReadonlyArray<string>
) => {
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-gcloud-"));
  const log = join(directory, "calls.log");
  const curlLog = join(directory, "curl.log");
  const curlStdin = join(directory, "curl.stdin");
  const sleepLog = join(directory, "sleep.log");
  const billingLog = join(directory, "billing.log");
  const quotaCounter = join(directory, "quota.count");
  const stub = join(directory, "gcloud");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$*" in
  *"projects describe"*"value(projectNumber)"*) echo "$STUB_PROJECT_NUMBER" ;;
  *"projects describe"*"value(labels)"*) [ -n "$STUB_LABELS_FAILS" ] && exit 1; echo "$STUB_LABELS" ;;
  *"billing projects describe"*) echo "$CLOUDSDK_BILLING_QUOTA_PROJECT" >> "${billingLog}"; echo True ;;
  *"auth print-access-token"*) echo stub-access-token ;;
  *"service-accounts create workspace-deployer "*)
    if [ -n "$STUB_DEPLOYER_EXISTS" ]; then
      echo "ERROR: (gcloud.iam.service-accounts.create) Resource in projects is the subject of a conflict: Service account workspace-deployer already exists within project" >&2
      exit 1
    fi ;;
  *"service-accounts create workspace-api "*)
    count=$(cat "${quotaCounter}" 2>/dev/null || echo 0)
    if [ "$count" -lt "\${STUB_SA_QUOTA_FAILURES:-0}" ]; then
      echo $((count + 1)) > "${quotaCounter}"
      echo "ERROR: (gcloud.iam.service-accounts.create) RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Service Account Creation Requests'" >&2
      exit 1
    fi ;;
  *"projects remove-iam-policy-binding"*)
    if [ -n "$STUB_REMOVE_ERROR" ]; then
      echo "$STUB_REMOVE_ERROR" >&2
      exit 1
    fi ;;
  *"projects get-iam-policy"*) printf '%s\n' "$STUB_DEPLOYER_ROLES" ;;
  *"providers list"*"workspace-vercel"*) printf '%s\n' "$STUB_VERCEL_PROVIDERS" ;;
  *"providers list"*) echo "projects/$STUB_PROJECT_NUMBER/locations/global/workloadIdentityPools/workspace-sandbox-github/providers/deskohub-workspace" ;;
  *"workspace-vercel"*"value(oidc.issuerUri)"*) echo https://oidc.vercel.com/example-team ;;
  *"workspace-vercel"*"value(oidc.jwksJson)"*) echo "$STUB_VERCEL_JWKS" ;;
  *"value(oidc.issuerUri)"*) echo https://token.actions.githubusercontent.com ;;
  *"value(oidc.jwksJson)"*) [ -n "$STUB_JWKS_FAILS" ] && exit 1; echo "$STUB_JWKS" ;;
  *"value(location,location_type)"*) printf '%s\n' "$STUB_BUCKET_LOCATION" ;;
  *describe*) exit 1 ;;
esac
`
  );
  chmodSync(stub, 0o755);
  writeFileSync(
    join(directory, "curl"),
    `#!/usr/bin/env bash
echo "$*" >> "${curlLog}"
cat > "${curlStdin}"
echo '{"done":true}'
`
  );
  chmodSync(join(directory, "curl"), 0o755);
  writeFileSync(
    join(directory, "sleep"),
    `#!/usr/bin/env bash
echo "$*" >> "${sleepLog}"
`
  );
  chmodSync(join(directory, "sleep"), 0o755);
  const result = Bun.spawnSync(["bash", bootstrapScript, ...args], {
    env: {
      PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      STUB_PROJECT_NUMBER: answers.projectNumber,
      STUB_JWKS: answers.jwksJson ?? "",
      STUB_JWKS_FAILS: answers.jwksLookupFails ? "1" : "",
      STUB_BUCKET_LOCATION: answers.bucketLocation ?? "EUROPE-WEST1\tregion",
      STUB_LABELS: answers.labels ?? "",
      STUB_LABELS_FAILS: answers.labelsLookupFails ? "1" : "",
      STUB_SA_QUOTA_FAILURES: String(answers.serviceAccountQuotaFailures ?? 0),
      STUB_DEPLOYER_EXISTS: answers.deployerAlreadyExists ? "1" : "",
      STUB_VERCEL_PROVIDERS:
        answers.vercelProviders ?? `${vercelPool}/providers/vercel`,
      STUB_VERCEL_JWKS: answers.vercelJwksJson ?? "",
      STUB_REMOVE_ERROR: answers.removeBindingError ?? "",
      STUB_DEPLOYER_ROLES: answers.deployerRoles ?? "",
    },
  });
  const lines = (path: string) =>
    Bun.spawnSync(["cat", path]).stdout.toString().split("\n").filter(Boolean);
  const recorded = {
    calls: lines(log),
    curlCalls: lines(curlLog),
    curlStdin: lines(curlStdin),
    sleeps: lines(sleepLog),
    billingQuotaProjects: lines(billingLog),
  };
  rmSync(directory, { recursive: true, force: true });
  return { result, ...recorded };
};

const liveArgs = dryRunArgs.filter((arg) => arg !== "--dry-run");

describe("sandbox bootstrap script", () => {
  test("refuses a project number that is not the project's before any change", () => {
    const { result, calls } = runLiveBootstrap(
      { projectNumber: "999999999999" },
      ...liveArgs
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--project-number");
    expect(calls).toEqual([
      "projects describe deskohub-ws-sandbox --format=value(projectNumber)",
    ]);
  });

  test("refuses a provider with uploaded signing keys before granting deploy access", () => {
    const { result, calls } = runLiveBootstrap(
      { projectNumber: "123456789012", jwksJson: '{"keys":[]}' },
      ...liveArgs
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("uploaded signing keys");
    expect(calls.some((call) => call.includes("workloadIdentityUser"))).toBe(
      false
    );
  });

  test("refuses deploy access when the signing-key lookup fails", () => {
    const { result, calls } = runLiveBootstrap(
      { projectNumber: "123456789012", jwksLookupFails: true },
      ...liveArgs
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "could not read the signing keys"
    );
    expect(calls.some((call) => call.includes("workloadIdentityUser"))).toBe(
      false
    );
  });

  test("grants deploy-subject access once the provider trusts GitHub's keys", () => {
    const { result, calls } = runLiveBootstrap(
      { projectNumber: "123456789012" },
      ...liveArgs
    );
    expect(result.exitCode).toBe(0);
    expect(calls.some((call) => call.includes("workloadIdentityUser"))).toBe(
      true
    );
  });

  const frontendGrant = (calls: ReadonlyArray<string>) =>
    calls.some(
      (call) =>
        call.startsWith(
          "iam service-accounts add-iam-policy-binding workspace-frontend-preview@"
        ) && call.includes("workloadIdentityUser")
    );

  test("grants the frontend preview identity once the Vercel provider is trusted", () => {
    const { result, calls } = runLiveBootstrap(
      { projectNumber: "123456789012" },
      ...liveArgs
    );
    expect(result.exitCode).toBe(0);
    expect(frontendGrant(calls)).toBe(true);
  });

  test.each([
    {
      answers: {
        vercelProviders: `${vercelPool}/providers/vercel\n${vercelPool}/providers/other`,
      },
      message: "must contain only provider vercel",
    },
    {
      answers: { vercelJwksJson: '{"keys":[]}' },
      message: "uploaded signing keys",
    },
  ])(
    "withholds the frontend preview identity when the Vercel provider is not trusted: $message",
    ({ answers, message }) => {
      const { result, calls } = runLiveBootstrap(
        { projectNumber: "123456789012", ...answers },
        ...liveArgs
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(message);
      expect(frontendGrant(calls)).toBe(false);
    }
  );

  test("treats an already removed trace-writer grant as removed", () => {
    const { result, calls } = runLiveBootstrap(
      {
        projectNumber: "123456789012",
        removeBindingError:
          "ERROR: Policy binding with the specified principal, role, and condition not found!",
      },
      ...liveArgs
    );
    expect(result.exitCode).toBe(0);
    expect(
      calls.filter((call) =>
        call.startsWith("projects remove-iam-policy-binding")
      )
    ).toHaveLength(6);
    expect(result.stdout.toString()).toContain("already absent; continuing");
  });

  test.each([
    "ERROR: PERMISSION_DENIED",
    "ERROR: (gcloud.projects.remove-iam-policy-binding) NOT_FOUND: Requested entity was not found.",
  ])(
    "stops when removing a trace-writer grant fails otherwise: %s",
    (removeBindingError) => {
      const { result } = runLiveBootstrap(
        { projectNumber: "123456789012", removeBindingError },
        ...liveArgs
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(removeBindingError);
      expect(result.stdout.toString()).not.toContain("already absent");
    }
  );

  test.each(["EUROPE-WEST3\tregion", "EU\tmulti-region"])(
    "refuses a state bucket outside the stage's region before changing it: %s",
    (bucketLocation) => {
      const { result, calls } = runLiveBootstrap(
        { projectNumber: "123456789012", bucketLocation },
        ...liveArgs
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("single-region bucket");
      expect(
        calls.some((call) => call.startsWith("storage buckets update"))
      ).toBe(false);
    }
  );

  test("merges the spend and teardown labels with the project's other labels", () => {
    const { result, calls, curlCalls, curlStdin } = runLiveBootstrap(
      {
        projectNumber: "123456789012",
        labels: "cost-centre=ops;workspace-sandbox-teardown=2026-01-01",
      },
      ...liveArgs
    );
    expect(result.exitCode).toBe(0);
    expect(calls.some((call) => call.startsWith("projects update"))).toBe(
      false
    );
    expect(curlCalls).toEqual([
      '-sS --fail-with-body -X PATCH https://cloudresourcemanager.googleapis.com/v3/projects/deskohub-ws-sandbox?updateMask=labels -H @- -H Content-Type: application/json --data {"labels":{"cost-centre":"ops","workspace-sandbox-max-spend":"200-eur","workspace-sandbox-teardown":"2026-12-31"}}',
    ]);
    // The token reaches curl on stdin, never its arguments or the output.
    expect(curlStdin).toEqual(["Authorization: Bearer stub-access-token"]);
    expect(result.stdout.toString()).not.toContain("stub-access-token");
  });

  test("leaves the labels untouched when they cannot be read", () => {
    const { result, curlCalls } = runLiveBootstrap(
      { projectNumber: "123456789012", labelsLookupFails: true },
      ...liveArgs
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("could not read the labels");
    expect(curlCalls).toEqual([]);
  });

  test("charges the billing check to the sandbox project's quota", () => {
    const { billingQuotaProjects } = runLiveBootstrap(
      { projectNumber: "123456789012" },
      ...liveArgs
    );
    expect(billingQuotaProjects).toEqual(["deskohub-ws-sandbox"]);
  });

  test("retries service account creation through the per-minute quota", () => {
    const { result, calls, sleeps } = runLiveBootstrap(
      {
        projectNumber: "123456789012",
        serviceAccountQuotaFailures: 2,
        deployerAlreadyExists: true,
      },
      ...liveArgs
    );
    expect(result.exitCode).toBe(0);
    expect(
      calls.filter((call) =>
        call.startsWith("iam service-accounts create workspace-api ")
      )
    ).toHaveLength(3);
    expect(sleeps).toEqual(["15", "30"]);
    // An account another run already created counts as created.
    expect(result.stdout.toString()).toContain("already exists; continuing");
  });

  test("stops after bounded quota retries", () => {
    const { result, calls, sleeps } = runLiveBootstrap(
      { projectNumber: "123456789012", serviceAccountQuotaFailures: 100 },
      ...liveArgs
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("RESOURCE_EXHAUSTED");
    expect(
      calls.filter((call) =>
        call.startsWith("iam service-accounts create workspace-api ")
      )
    ).toHaveLength(6);
    expect(sleeps).toEqual(["15", "30", "60", "60", "60"]);
    expect(
      calls.some((call) =>
        call.startsWith("iam service-accounts create workspace-tasks-worker ")
      )
    ).toBe(false);
  });

  test("prints the label update without a token and enables the trace and federation APIs", () => {
    const output = runBootstrap(...dryRunArgs).stdout.toString();
    expect(output).not.toContain("projects update");
    expect(output).toContain(
      "+ curl -sS --fail-with-body -X PATCH https://cloudresourcemanager.googleapis.com/v3/projects/deskohub-ws-sandbox\\?updateMask=labels -H Authorization:\\ Bearer\\ \\<gcloud\\ auth\\ print-access-token\\>"
    );
    expect(output).toContain(
      'workspace-sandbox-max-spend\\":\\"200-eur\\"\\,\\"workspace-sandbox-teardown\\":\\"2026-12-31'
    );
    const enabled = output.match(/gcloud services enable ([^\n]*)\n/)?.[1];
    for (const api of [
      "cloudtrace.googleapis.com",
      "cloudscheduler.googleapis.com",
      "compute.googleapis.com",
      "sts.googleapis.com",
      "iamcredentials.googleapis.com",
    ]) {
      expect(enabled?.split(" ")).toContain(api);
    }
  });

  test("revokes runtime trace writers and grants the deployer read and alert access", () => {
    const firstPhase = runBootstrap(...dryRunArgs).stdout.toString();
    const traceRoles =
      /--role roles\/(?:telemetry\.tracesWriter|cloudtrace\.agent)\b/;
    for (const account of [
      "workspace-web",
      "workspace-tasks-worker",
      "workspace-scheduler-worker",
    ]) {
      for (const role of [
        "roles/telemetry.tracesWriter",
        "roles/cloudtrace.agent",
      ]) {
        expect(firstPhase).toContain(
          `gcloud projects remove-iam-policy-binding deskohub-ws-sandbox --condition=None --quiet --member serviceAccount:${sandboxServiceAccount(account)} --role ${role} --format=none`
        );
      }
    }
    expect(
      firstPhase
        .split("\n")
        .filter((line) => traceRoles.test(line))
        .every((line) => line.includes(" remove-iam-policy-binding "))
    ).toBe(true);
    expect(firstPhase).not.toMatch(
      /roles\/(?:logging\.(?:viewer|configWriter)|cloudtrace\.user)\b/
    );

    const secondPhase = runBootstrap(
      ...dryRunArgs,
      "--grant-deploy-roles"
    ).stdout.toString();
    for (const role of [
      "roles/compute.viewer",
      "roles/logging.viewer",
      "roles/cloudtrace.user",
      "roles/logging.configWriter",
      "roles/monitoring.alertPolicyEditor",
    ]) {
      expect(secondPhase).toContain(
        `gcloud projects add-iam-policy-binding deskohub-ws-sandbox --condition=None --quiet --member serviceAccount:${sandboxServiceAccount("workspace-deployer")} --role ${role} --format=none`
      );
    }
    expect(secondPhase).not.toMatch(
      /roles\/compute\.(?:loadBalancerAdmin|securityAdmin)\b/
    );
  });

  describe("revoking the retired deployer edge roles", () => {
    const retiredEdgeRoles = [
      "roles/compute.loadBalancerAdmin",
      "roles/compute.securityAdmin",
    ];
    const keptRoles =
      "roles/run.admin\nroles/logging.viewer\nroles/cloudtrace.user\nroles/logging.configWriter";
    const revokeArgs = [
      ...liveArgs,
      "--grant-deploy-roles",
      "--revoke-retired-edge-roles",
    ];
    const edgeRemovals = (calls: ReadonlyArray<string>) =>
      calls.filter(
        (call) =>
          call.startsWith("projects remove-iam-policy-binding") &&
          call.includes(sandboxServiceAccount("workspace-deployer"))
      );

    test("removes the bindings an earlier bootstrap granted and reads the policy back", () => {
      const { result, calls } = runLiveBootstrap(
        { projectNumber: "123456789012", deployerRoles: keptRoles },
        ...revokeArgs
      );
      expect(result.exitCode).toBe(0);
      expect(edgeRemovals(calls)).toEqual(
        retiredEdgeRoles.map(
          (role) =>
            `projects remove-iam-policy-binding deskohub-ws-sandbox --condition=None --quiet --member serviceAccount:${sandboxServiceAccount("workspace-deployer")} --role ${role} --format=none`
        )
      );
      expect(
        calls.some((call) => call.startsWith("projects get-iam-policy"))
      ).toBe(true);
    });

    test("converges when the bindings are already gone", () => {
      const { result } = runLiveBootstrap(
        {
          projectNumber: "123456789012",
          deployerRoles: keptRoles,
          removeBindingError:
            "ERROR: Policy binding with the specified principal, role, and condition not found!",
        },
        ...revokeArgs
      );
      expect(result.exitCode).toBe(0);
    });

    test("fails when readback still shows a retired role", () => {
      const { result } = runLiveBootstrap(
        {
          projectNumber: "123456789012",
          deployerRoles: `${keptRoles}\nroles/compute.securityAdmin`,
        },
        ...revokeArgs
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("roles/compute.securityAdmin");
    });

    test("fails when the deployer lost trace read access", () => {
      const { result } = runLiveBootstrap(
        {
          projectNumber: "123456789012",
          deployerRoles: keptRoles.replace("\nroles/cloudtrace.user", ""),
        },
        ...revokeArgs
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("roles/cloudtrace.user");
    });

    test("fails when readback is missing the scheduler alert's logging role", () => {
      const { result } = runLiveBootstrap(
        {
          projectNumber: "123456789012",
          deployerRoles: keptRoles.replace("\nroles/logging.configWriter", ""),
        },
        ...revokeArgs
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "the deployer lost roles/logging.configWriter"
      );
    });

    test("never revokes without the deploy-roles phase", () => {
      const { result, calls } = runLiveBootstrap(
        { projectNumber: "123456789012", deployerRoles: keptRoles },
        ...liveArgs,
        "--revoke-retired-edge-roles"
      );
      expect(result.exitCode).toBe(1);
      expect(edgeRemovals(calls)).toEqual([]);
    });
  });

  test("gives the API runtime the retired web runtime's task and deploy access", () => {
    const secondPhase = runBootstrap(
      ...dryRunArgs,
      "--grant-deploy-roles"
    ).stdout.toString();
    const api = sandboxServiceAccount("workspace-api");
    expect(secondPhase).toContain(
      `gcloud projects add-iam-policy-binding deskohub-ws-sandbox --condition=None --quiet --member serviceAccount:${api} --role roles/cloudtasks.enqueuer --format=none`
    );
    expect(secondPhase).toContain(
      `gcloud iam service-accounts add-iam-policy-binding ${sandboxServiceAccount("workspace-tasks-invoker")} --project deskohub-ws-sandbox --member serviceAccount:${api} --role roles/iam.serviceAccountUser --format=none`
    );
    expect(secondPhase).toContain(
      `gcloud iam service-accounts add-iam-policy-binding ${api} --project deskohub-ws-sandbox --member serviceAccount:${sandboxServiceAccount("workspace-deployer")} --role roles/iam.serviceAccountUser --format=none`
    );
    // workspace-web appears only where its old trace grants are revoked.
    expect(
      secondPhase
        .split("\n")
        .filter((line) => line.includes("workspace-web"))
        .every((line) => line.includes(" remove-iam-policy-binding "))
    ).toBe(true);
  });

  test("trusts Vercel only for the project's preview deployments", () => {
    const output = runBootstrap(...dryRunArgs).stdout.toString();
    const providerFlags =
      "--issuer-uri https://oidc.vercel.com/example-team --allowed-audiences https://vercel.com/example-team --attribute-mapping google.subject=assertion.sub\\,attribute.owner_id=assertion.owner_id\\,attribute.project_id=assertion.project_id\\,attribute.environment=assertion.environment --attribute-condition assertion.owner_id==\\'team_example1001\\'\\ \\&\\&\\ assertion.project_id==\\'prj_example2002\\'\\ \\&\\&\\ assertion.environment==\\'preview\\'\n";
    expect(output).toContain(
      "+ gcloud iam workload-identity-pools create workspace-vercel --project deskohub-ws-sandbox --location global --display-name Vercel\\ OIDC\n"
    );
    expect(output).toContain(
      `+ gcloud iam workload-identity-pools providers create-oidc vercel --project deskohub-ws-sandbox --location global --workload-identity-pool workspace-vercel --display-name Vercel\\ preview ${providerFlags}`
    );
    expect(output).toContain(
      `+ gcloud iam workload-identity-pools providers update-oidc vercel --project deskohub-ws-sandbox --location global --workload-identity-pool workspace-vercel ${providerFlags}`
    );
    const frontend = sandboxServiceAccount("workspace-frontend-preview");
    expect(output).toContain(
      "gcloud iam service-accounts create workspace-frontend-preview "
    );
    const frontendGrants = output
      .split("\n")
      .filter((line) => line.includes(frontend));
    expect(frontendGrants).toEqual([
      `+ gcloud iam service-accounts add-iam-policy-binding ${frontend} --project deskohub-ws-sandbox --role roles/iam.workloadIdentityUser --format=none --member principal://iam.googleapis.com/${vercelPool}/subject/owner:example-team:project:example-frontend:environment:preview`,
      `WORKSPACE_FRONTEND_SERVICE_ACCOUNT=${frontend}`,
    ]);
    expect(output).toContain(
      "WORKSPACE_GCP_PROJECT_NUMBER=123456789012\nWORKSPACE_WIF_POOL=workspace-vercel\nWORKSPACE_WIF_PROVIDER=vercel\n"
    );
  });

  test.each([
    ["--vercel-owner-id", "team_x' || true || '"],
    ["--vercel-project-id", "example-project"],
    ["--vercel-project", "example:environment:production"],
    ["--vercel-team-slug", ""],
  ] as const)(
    "rejects a %s that could widen the provider condition",
    (flag, value) => {
      const args = [...dryRunArgs];
      args[args.indexOf(flag) + 1] = value;
      const result = runBootstrap(...args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(flag);
      expect(result.stdout.toString()).toBe("");
    }
  );

  // owner:example-team:project:<name>:environment:preview is 47 bytes
  // plus the project name; Google maps subjects of at most 127 bytes.
  test("accepts a preview subject of 127 bytes", () => {
    const args = [...dryRunArgs];
    args[args.indexOf("--vercel-project") + 1] = "p".repeat(80);
    expect(runBootstrap(...args).exitCode).toBe(0);
  });

  test("rejects a preview subject of 128 bytes before any change", () => {
    const args = [...dryRunArgs];
    args[args.indexOf("--vercel-project") + 1] = "p".repeat(81);
    const result = runBootstrap(...args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("127 bytes");
    expect(result.stdout.toString()).toBe("");
  });

  test("rejects a multibyte project name in a UTF-8 locale", () => {
    // 41 two-byte letters: 88 characters but 129 bytes of subject, and
    // [a-z] admits them under en_US.UTF-8 collation.
    const args = [...dryRunArgs];
    args[args.indexOf("--vercel-project") + 1] = "\u00e9".repeat(41);
    const result = Bun.spawnSync(["bash", bootstrapScript, ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LC_ALL: "en_US.UTF-8",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--vercel-project");
    expect(result.stdout.toString()).toBe("");
  });

  test("passes bash -n", () => {
    const result = Bun.spawnSync(["bash", "-n", bootstrapScript]);
    expect(result.exitCode).toBe(0);
  });

  test("rejects a non-numeric GitHub repository ID", () => {
    const args = [...dryRunArgs];
    args[args.indexOf("2002")] = "example-repo";
    const result = runBootstrap(...args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--github-repository-id");
  });

  test("restricts federation to the trusted workflow, environment and IDs", () => {
    const result = runBootstrap(...dryRunArgs);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain(
      "assertion.repository_owner_id\\ ==\\ \\'1001\\'\\ \\&\\&\\ assertion.repository_id\\ ==\\ \\'2002\\'\\ \\&\\&\\ assertion.environment\\ ==\\ \\'workspace-gcp-sandbox\\'\\ \\&\\&\\ assertion.workflow_ref\\ ==\\ \\'example-owner/example-repo/.github/workflows/workspace-gcp-sandbox-smoke.yml@refs/heads/main\\'"
    );
    expect(output).toContain(
      "--role roles/iam.workloadIdentityUser --format=none --member principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/workspace-sandbox-github/subject/repo:example-owner/example-repo:environment:workspace-gcp-sandbox"
    );
    for (const account of [
      "workspace-deployer",
      "workspace-api",
      "workspace-tasks-worker",
      "workspace-scheduler-worker",
      "workspace-tasks-invoker",
      "workspace-scheduler-invoker",
      "workspace-mobile-publisher",
      "workspace-frontend-preview",
    ]) {
      expect(output).toContain(
        `gcloud iam service-accounts create ${account} `
      );
    }
    expect(output).not.toContain(
      "gcloud iam service-accounts create workspace-web "
    );
    expect(output).not.toMatch(
      /roles\/(?:owner|editor|iam\.securityAdmin|resourcemanager\.projectIamAdmin|secretmanager\.(?:admin|secretAccessor))\b/
    );
    expect(output).toContain(
      "gcloud storage buckets update gs://deskohub-ws-sandbox-workspace-state --versioning"
    );
    // Google's agents sign task and schedule requests as the invokers.
    for (const [invoker, agent] of [
      ["workspace-tasks-invoker", "gcp-sa-cloudtasks"],
      ["workspace-scheduler-invoker", "gcp-sa-cloudscheduler"],
    ] as const) {
      expect(output).toContain(
        `gcloud iam service-accounts add-iam-policy-binding ${sandboxServiceAccount(invoker)} --project deskohub-ws-sandbox --role roles/iam.serviceAccountTokenCreator --format=none --member serviceAccount:service-123456789012@${agent}.iam.gserviceaccount.com`
      );
    }
    // Cloud Tasks' primary agent may also act as the tasks invoker.
    expect(output).toContain(
      `gcloud iam service-accounts add-iam-policy-binding ${sandboxServiceAccount("workspace-tasks-invoker")} --project deskohub-ws-sandbox --role roles/iam.serviceAccountUser --format=none --member serviceAccount:service-123456789012@${"gcp-sa-cloudtasks"}.iam.gserviceaccount.com`
    );
    // The provider update converges issuer and mapping, not only the condition.
    expect(output).toMatch(
      /providers update-oidc deskohub-workspace .*--issuer-uri https:\/\/token\.actions\.githubusercontent\.com --attribute-mapping google\.subject=assertion\.sub/
    );
  });

  test("grants deploy roles only in the second phase and scopes secret IAM", () => {
    const firstPhase = runBootstrap(...dryRunArgs).stdout.toString();
    expect(firstPhase).not.toContain("roles/run.admin");
    expect(firstPhase).not.toContain("workspaceSecretIamManager");
    expect(firstPhase).toContain("--role roles/browser");
    expect(firstPhase).toContain(
      "gcloud storage buckets add-iam-policy-binding gs://deskohub-ws-sandbox-workspace-state"
    );
    expect(firstPhase).toContain(
      "gcloud storage buckets update gs://deskohub-ws-sandbox-workspace-state --versioning --uniform-bucket-level-access --public-access-prevention"
    );

    const secondPhase = runBootstrap(
      ...dryRunArgs,
      "--grant-deploy-roles",
      "--managed-secret",
      "workspace-database-url"
    ).stdout.toString();
    expect(secondPhase).toContain("--role roles/run.admin");
    expect(secondPhase).toContain(
      "gcloud secrets add-iam-policy-binding workspace-database-url --project deskohub-ws-sandbox"
    );
    // The secret IAM role is never bound on the project.
    expect(secondPhase).not.toMatch(
      /projects add-iam-policy-binding [^\n]*workspaceSecretIamManager/
    );
  });

  test("prints the gh variable commands and no secret values", () => {
    const output = runBootstrap(...dryRunArgs).stdout.toString();
    const ghCommands = output
      .split("\n")
      .filter((line) => line.startsWith("gh variable set"));
    expect(ghCommands).toEqual([
      "gh variable set GCP_SANDBOX_PROJECT_ID --repo example-owner/example-repo --env workspace-gcp-sandbox --body deskohub-ws-sandbox",
      "gh variable set GCP_SANDBOX_WIF_PROVIDER --repo example-owner/example-repo --env workspace-gcp-sandbox --body projects/123456789012/locations/global/workloadIdentityPools/workspace-sandbox-github/providers/deskohub-workspace",
      `gh variable set GCP_SANDBOX_DEPLOY_SA --repo example-owner/example-repo --env workspace-gcp-sandbox --body ${sandboxServiceAccount("workspace-deployer")}`,
      "gh variable set GCP_SANDBOX_STATE_BUCKET --repo example-owner/example-repo --env workspace-gcp-sandbox --body deskohub-ws-sandbox-workspace-state",
    ]);
    expect(output).not.toMatch(
      /gh secret|service-accounts keys|versions add|--data-file/
    );
    expect(Object.keys(workflow.jobs.smoke?.env ?? {})).toEqual(
      ghCommands.map((line) => line.split(" ")[3] ?? "")
    );
  });
});
