import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import {
  type FakeRule,
  type FakeWorld,
  fakeServiceUrl,
  fakeWriterFingerprint,
  type ProofFakes,
  withProofFakes,
} from "./sandbox-proof-fakes.test-utils";

/**
 * Behavioural tests of the hosted proof runner's live paths against
 * stateful fake CLIs: nothing here reaches Google Cloud.
 */

const runner = new URL("../scripts/sandbox-hosted-proof.sh", import.meta.url)
  .pathname;
const packageRoot = new URL("..", import.meta.url).pathname;

const projectId = "deskohub-workspace-sandbox";
const stateBucket = "deskohub-workspace-sandbox-workspace-state";
const stackPrefix = "DeskohubWorkspace/sandbox/";
const lease = `${stackPrefix}__lease__.json`;
const traceId = "0123456789abcdef0123456789abcdef";
const v1Digest = `sha256:${"1".repeat(64)}`;
const v3Digest = `sha256:${"3".repeat(64)}`;

const sandboxEnv = {
  GCP_SANDBOX_PROJECT_ID: projectId,
  GCP_SANDBOX_STATE_BUCKET: stateBucket,
  SANDBOX_EXPECTED_PROJECT_ID: projectId,
  SANDBOX_EXPECTED_PROJECT_NUMBER: "759037106024",
  SANDBOX_EXPECTED_STATE_BUCKET: stateBucket,
  SANDBOX_REGION: "europe-west1",
  SANDBOX_PROOF_MODE: "hosted-proof",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "1".repeat(40),
  GITHUB_RUN_ID: "111",
  GITHUB_RUN_ATTEMPT: "1",
  GOOGLE_ACCESS_TOKEN: "fake-access-token",
  // Far in the future, so the runner never mints a token.
  GOOGLE_ACCESS_TOKEN_EXPIRES_AT: "99999999999",
};

const runPhase = (
  fakes: ProofFakes,
  phase: string | ReadonlyArray<string>,
  env: Record<string, string> = {}
) => {
  const result = Bun.spawnSync(["bash", runner, ...[phase].flat()], {
    cwd: packageRoot,
    env: {
      HOME: process.env.HOME ?? "/tmp",
      ...sandboxEnv,
      ...fakes.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

const seed = (fakes: ProofFakes, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(fakes.proofDir, name), content);
  }
};

const settled = (digest?: string) => {
  const record = { generation: 3, writer: null, pendingApply: null };
  return {
    version: "1",
    record:
      digest === undefined
        ? record
        : {
            ...record,
            active: { imageDigest: digest, releaseId: "release-3" },
          },
  };
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The project's log exclusions: none, read in one page. */
const noExclusions: FakeRule = {
  tool: "curl",
  pattern: "logging\\.googleapis\\.com/v2/projects/.*/exclusions",
  stdout: '{"exclusions":[]}',
};

const sinksPage = (
  parent: string,
  sinks: ReadonlyArray<Schema.JsonObject>,
  page: { readonly token?: string; readonly next?: string } = {}
): FakeRule => ({
  tool: "curl",
  pattern: `logging\\.googleapis\\.com/v2/${parent}/sinks\\?pageSize=100${
    page.token === undefined ? "" : `&pageToken=${page.token}`
  }$`,
  stdout: JSON.stringify(
    page.next === undefined ? { sinks } : { sinks, nextPageToken: page.next }
  ),
});

/** One Compute collection's aggregatedList answer, by scope. */
const computeList = (
  collection: string,
  body: Schema.JsonObject
): FakeRule => ({
  tool: "curl",
  pattern: `compute\\.googleapis\\.com/compute/v1/projects/${projectId}/aggregated/${collection}\\?maxResults=500&returnPartialSuccess=false$`,
  stdout: JSON.stringify(body),
});

/**
 * Reads every inventory needs: no exclusions, no custom sinks, and every
 * Compute collection complete and empty.
 */
const readableLogging: ReadonlyArray<FakeRule> = [
  {
    tool: "curl",
    pattern: "compute\\.googleapis\\.com/compute/v1/projects/.*/aggregated/",
    stdout: JSON.stringify({
      items: {
        global: { warning: { code: "NO_RESULTS_ON_PAGE" } },
        "regions/europe-west1": { warning: { code: "NO_RESULTS_ON_PAGE" } },
      },
    }),
  },
  noExclusions,
  sinksPage(`projects/${projectId}`, [
    { name: "_Default", destination: "logging/_Default" },
  ]),
];

describe("cleanup under the writer lock", () => {
  const directDeletes =
    /run services delete|tasks queues delete|artifacts repositories delete/;

  test("stops when the stale writer lock cannot be released", () => {
    withProofFakes(
      {
        status: {
          version: "1",
          record: {
            generation: 4,
            writer: { holder: "h" },
            pendingApply: null,
          },
        },
        rules: [
          { tool: "bun", pattern: "^release\\.run\\.ts unlock", exit: 1 },
        ],
      },
      (fakes) => {
        seed(fakes, {
          "stack-config.json": "{}",
          "interrupted-dead-holder": "h\n",
        });
        const { exitCode, output } = runPhase(fakes, "stack-destroy");
        expect(exitCode).toBe(1);
        expect(output).toContain("was not released; nothing was destroyed");
        const calls = fakes.calls().join("\n");
        expect(calls).not.toMatch(directDeletes);
        expect(calls).not.toContain("sandbox-locked-stack.ts destroy");
        expect(calls).not.toContain("storage rm");
      }
    );
  });

  const heldBy = (holder: string, rules: ReadonlyArray<FakeRule> = []) => ({
    status: {
      version: "1",
      record: { generation: 4, writer: { holder }, pendingApply: null },
    },
    rules,
  });

  test("leaves a lock whose holder this run did not prove dead", () => {
    for (const deadHolder of [null, "another-holder"]) {
      withProofFakes(heldBy("live-holder"), (fakes) => {
        seed(fakes, { "stack-config.json": "{}" });
        if (deadHolder !== null) {
          seed(fakes, { "interrupted-dead-holder": `${deadHolder}\n` });
        }
        const { exitCode, output } = runPhase(fakes, "stack-destroy");
        expect(exitCode).toBe(1);
        expect(output).toContain("whose death this run did not establish");
        const calls = fakes.calls().join("\n");
        expect(calls).not.toContain("unlock");
        expect(calls).not.toContain("sandbox-locked-stack.ts destroy");
      });
    }
  });

  test("leaves the lock when the Alchemy lease is unreadable", () => {
    const leaseRead = "storage\\.googleapis\\.com/storage/v1/b/.*__lease__";
    for (const failure of [
      // Expired or missing credentials, worded like an absent object.
      { stdout: '{"error":{"code":401,"message":"File not found"}}\n401' },
      // A 404 for the bucket, not the lease object.
      {
        stdout:
          '{"error":{"code":404,"message":"The specified bucket does not exist."}}\n404',
      },
      // A transport failure.
      { exit: 7 },
    ]) {
      withProofFakes(
        heldBy("h", [{ tool: "curl", pattern: leaseRead, ...failure }]),
        (fakes) => {
          seed(fakes, {
            "stack-config.json": "{}",
            "interrupted-dead-holder": "h\n",
          });
          const { exitCode, output } = runPhase(fakes, "stack-destroy");
          expect({ failure, exitCode }).toEqual({ failure, exitCode: 1 });
          expect(output).toContain("the Alchemy lease is unreadable");
          expect(fakes.calls().join("\n")).not.toContain("unlock");
        }
      );
    }
  });

  test("reads a missing lease object as absent, not unreadable", () => {
    withProofFakes(heldBy("h"), (fakes) => {
      seed(fakes, {
        "stack-config.json": "{}",
        "interrupted-dead-holder": "h\n",
      });
      const { output } = runPhase(fakes, "stack-destroy");
      expect(output).not.toContain("the Alchemy lease is unreadable");
      expect(fakes.calls().join("\n")).toContain("unlock --holder h");
    });
  });

  test("deletes nothing outside the lock when the locked destroy is refused", () => {
    withProofFakes(
      {
        status: settled(),
        rules: [
          {
            tool: "bun",
            pattern: "^scripts/sandbox-locked-stack\\.ts destroy",
            exit: 1,
          },
        ],
      },
      (fakes) => {
        seed(fakes, { "stack-config.json": "{}" });
        const { exitCode, output } = runPhase(fakes, "stack-destroy");
        expect(exitCode).toBe(1);
        expect(output).toContain("nothing was deleted outside the lock");
        const calls = fakes.calls().join("\n");
        expect(calls).not.toMatch(directDeletes);
        expect(calls).not.toContain("storage rm");
      }
    );
  });
});

describe("release command output", () => {
  // What Alchemy's GCP auth logged before the JSON in run 45279064237.
  const alchemyLog =
    "[22:30:23.620] INFO (#12): GCP: using environment variables (GOOGLE_ACCESS_TOKEN, GOOGLE_PROJECT_ID).";
  const status = (
    record: Schema.JsonObject,
    logs: "stdout" | "stderr"
  ): FakeRule => ({
    tool: "bun",
    pattern: "^release\\.run\\.ts status",
    ...(logs === "stdout"
      ? { stdout: `${alchemyLog}\n${JSON.stringify(record)}` }
      : { stdout: JSON.stringify(record), stderr: alchemyLog }),
  });
  const plan = (summary: string): FakeRule => ({
    tool: "bun",
    pattern: "^release\\.run\\.ts plan",
    stderr: `${alchemyLog}\nPlan: ${summary}`,
  });
  // Cloud Run serves v1 once delivered; the rules answer the status.
  const deliverV1 = (rules: ReadonlyArray<FakeRule>) =>
    withProofFakes({ status: settled(v1Digest), rules }, (fakes) => {
      seed(fakes, { "digests.env": `PROBE_V1_DIGEST=${v1Digest}\n` });
      return runPhase(fakes, "deliver-v1");
    });

  test("reads a status whose logs went to stderr and a plan printed there", () => {
    const { exitCode, output } = deliverV1([
      status(settled(v1Digest), "stderr"),
      plan("no changes"),
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(
      deliverV1([status(settled(v1Digest), "stderr"), plan("1 to update")])
        .exitCode
    ).toBe(1);
  });

  test("fails clearly when a log reaches the status JSON on stdout", () => {
    const { exitCode, output } = deliverV1([
      status(settled(v1Digest), "stdout"),
      plan("no changes"),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("printed no single JSON record");
    expect(output).not.toContain("writer lock: expected");
  });

  test("tears down under the lock even when the status is unreadable", () => {
    withProofFakes({ rules: [status(settled(), "stdout")] }, (fakes) => {
      const { exitCode, output } = runPhase(fakes, "stack-destroy");
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      const calls = fakes.calls();
      expect(calls).toContain("bun scripts/sandbox-locked-stack.ts destroy");
      expect(calls.some((call) => call.includes("release.run.ts unlock"))).toBe(
        false
      );
    });
  });
});

describe("drift detection", () => {
  const injected = "sandbox proof drift 111";
  const declared = "Workspace container images, deployed by digest.";
  // The fake repository keeps the injected description until a repair.
  const driftWith = (driftExit: number) =>
    withProofFakes(
      {
        rules: [
          {
            tool: "bun",
            pattern: "^scripts/sandbox-locked-stack\\.ts drift",
            exit: driftExit,
          },
          {
            tool: "bun",
            pattern: "^scripts/sandbox-locked-stack\\.ts repair",
            set: { repositoryDescription: declared },
          },
          {
            tool: "bun",
            pattern: "^release\\.run\\.ts plan",
            stderr: "Plan: no changes",
          },
        ],
      },
      (fakes) => {
        seed(fakes, { "stack-config.json": "{}" });
        const { exitCode, output } = runPhase(fakes, "drift");
        return { exitCode, output, calls: fakes.calls() };
      }
    );

  test("repairs once Alchemy reports the injected drift", () => {
    const { exitCode, output, calls } = driftWith(2);
    expect(calls).toContain(
      `gcloud artifacts repositories update workspace --project=deskohub-workspace-sandbox --location=europe-west1 --description=${injected}`
    );
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(calls).toContain("bun scripts/sandbox-locked-stack.ts repair");
  });

  test("fails as a failed check, not as no drift, when Alchemy errors", () => {
    const { exitCode, output, calls } = driftWith(1);
    expect(exitCode).toBe(1);
    expect(output).toContain("drift check failed (exit 1)");
    expect(output).not.toContain("reported no drift");
    expect(calls).not.toContain("bun scripts/sandbox-locked-stack.ts repair");
  });

  test("fails when Alchemy finds a clean stage after the injection", () => {
    const { exitCode, output, calls } = driftWith(0);
    expect(exitCode).toBe(1);
    expect(output).toContain("reported no drift");
    expect(calls).not.toContain("bun scripts/sandbox-locked-stack.ts repair");
  });
});

// One page of a parent's sinks as the Logging API lists them; a later
// page is the one asked for by the earlier page's token.
describe("read-only inventory", () => {
  test("reports the project's log sinks from every page", () => {
    const { exitCode, output } = withProofFakes(
      {
        rules: [
          sinksPage(
            `projects/${projectId}`,
            [
              {
                name: "export",
                destination: "bigquery.googleapis.com/x",
                filter: "severity>=ERROR",
              },
            ],
            { token: "page-2" }
          ),
          sinksPage(
            `projects/${projectId}`,
            [{ name: "_Default", destination: "logging/_Default" }],
            { next: "page-2" }
          ),
          ...readableLogging,
        ],
      },
      (fakes) => runPhase(fakes, "readonly-inventory")
    );
    expect({
      exitCode,
      sinks: output
        .split("\n")
        .filter((line) => /^(_Default|export)\t/.test(line)),
    }).toEqual({
      exitCode: 0,
      sinks: [
        "_Default\tlogging/_Default\t(empty filter)",
        "export\tbigquery.googleapis.com/x\tseverity>=ERROR",
      ],
    });
  });
});

describe("post-destroy inventory", () => {
  const state = `gs://${stateBucket}`;
  // `storage ls -r` once the stack is gone: folder headings, the
  // Alchemy lease and nothing else.
  const emptiedState = [
    `${state}/:`,
    "",
    `${state}/DeskohubWorkspace/:`,
    "",
    `${state}/${stackPrefix}:`,
    `${state}/${lease}`,
  ].join("\n");
  const inventory = (rules: ReadonlyArray<FakeRule>) =>
    withProofFakes({ rules: [...rules, ...readableLogging] }, (fakes) =>
      runPhase(fakes, "post-destroy-inventory")
    );
  const listing = (pattern: string, stdout: string): FakeRule => ({
    tool: "gcloud",
    pattern,
    stdout,
  });

  test("lists the project's log sinks from every page", () => {
    const listed = withProofFakes(
      {
        rules: [
          listing("^storage ls -r", emptiedState),
          sinksPage(
            `projects/${projectId}`,
            [{ name: "export", destination: "bigquery.googleapis.com/x" }],
            { token: "page-2" }
          ),
          sinksPage(
            `projects/${projectId}`,
            [{ name: "_Default", destination: "logging/_Default" }],
            { next: "page-2" }
          ),
          ...readableLogging,
        ],
      },
      (fakes) => {
        const { exitCode } = runPhase(fakes, "post-destroy-inventory");
        const file = join(
          fakes.proofDir,
          "inventory-post-destroy",
          "logging-sinks.txt"
        );
        return {
          exitCode,
          sinks: existsSync(file) ? readFileSync(file, "utf8") : null,
        };
      }
    );
    expect(listed).toEqual({
      exitCode: 0,
      sinks: "_Default\tlogging/_Default\nexport\tbigquery.googleapis.com/x\n",
    });
  });

  test("counts folder headings and the lease as no residue", () => {
    const { exitCode, output } = inventory([
      listing("^storage ls -r", emptiedState),
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  });

  test.each([
    [
      "unreachable scopes",
      { items: {}, unreachables: ["regions/europe-west4"] },
    ],
    [
      "an unreachable zone warning",
      {
        items: {
          "zones/europe-west1-b": { warning: { code: "UNREACHABLE" } },
        },
      },
    ],
    [
      "a partial page warning",
      { items: {}, warning: { code: "PARTIAL_SUCCESS" } },
    ],
    [
      "a partial region warning",
      {
        items: {
          "regions/europe-west1": { warning: { code: "PARTIAL_SUCCESS" } },
        },
      },
    ],
    ["invalid items", { items: false }],
    ["a null page warning", { items: {}, warning: null }],
    ["a null scope warning", { items: { global: { warning: null } } }],
    [
      "invalid forwarding rules",
      { items: { global: { forwardingRules: false } } },
    ],
    [
      "invalid unreachable scopes",
      { items: {}, unreachables: "regions/europe-west4" },
    ],
  ] satisfies ReadonlyArray<readonly [string, Schema.JsonObject]>)(
    "fails on a partial Compute listing with %s",
    (_case, body) => {
      const { exitCode, output } = inventory([
        computeList("forwardingRules", body),
        listing("^storage ls -r", emptiedState),
      ]);
      expect(exitCode).toBe(1);
      expect(output).toContain("teardown unverified: forwarding-rules");
    }
  );

  test("finds a resource on a later Compute page", () => {
    const { exitCode, output } = inventory([
      {
        tool: "curl",
        pattern:
          "/aggregated/backendServices\\?maxResults=500&returnPartialSuccess=false&pageToken=a%2Bb$",
        stdout: JSON.stringify({
          items: {
            "regions/europe-west1": {
              backendServices: [{ name: "legacy-backend" }],
            },
          },
        }),
      },
      computeList("backendServices", {
        items: { global: { warning: { code: "NO_RESULTS_ON_PAGE" } } },
        nextPageToken: "a+b",
      }),
      listing("^storage ls -r", emptiedState),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "proof resources remain in backend-services: legacy-backend"
    );
  });

  test("fails when any class cannot be listed", () => {
    const { exitCode, output } = inventory([
      { tool: "gcloud", pattern: "^run revisions list", exit: 1 },
      listing("^storage ls -r", emptiedState),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("teardown unverified: run-revisions");
  });

  test("keeps the isolated backend preview out of sandbox proof residue", () => {
    const preview = [
      listing(
        "^run services list",
        "workspace-api-preview\nworkspace-tasks-preview"
      ),
      listing(
        "^run revisions list",
        "workspace-api-preview-g-abcdef1234567890\nworkspace-scheduler-preview-seed"
      ),
      listing("^storage ls -r", emptiedState),
    ];
    expect(inventory(preview).exitCode).toBe(0);
  });

  test("reports a service outside the exact preview inventory", () => {
    const result = inventory([
      listing(
        "^run services list",
        "workspace-api-preview\nworkspace-api-preview-orphan"
      ),
      listing("^storage ls -r", emptiedState),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "proof resources remain in run-services: workspace-api-preview-orphan"
    );
  });

  test("lists every Compute class across all of the project's scopes", () => {
    const { exitCode, calls } = withProofFakes(
      { rules: [listing("^storage ls -r", emptiedState), ...readableLogging] },
      (fakes) => ({
        exitCode: runPhase(fakes, "post-destroy-inventory").exitCode,
        calls: fakes.calls().filter((call) => call.includes("/aggregated/")),
      })
    );
    expect(exitCode).toBe(0);
    expect(
      calls.map((call) => call.match(/\/aggregated\/([A-Za-z]+)\?/)?.[1])
    ).toEqual([
      "forwardingRules",
      "addresses",
      "backendServices",
      "urlMaps",
      "targetHttpProxies",
      "targetHttpsProxies",
      "networkEndpointGroups",
      "securityPolicies",
      "sslCertificates",
    ]);
  });

  test.each([
    [
      "stack resource",
      listing(
        "^storage ls -r",
        `${emptiedState}\n${state}/${stackPrefix}WorkspaceWeb.json`
      ),
    ],
    [
      "proof run record",
      listing(
        "^storage ls -r",
        `${emptiedState}\n${state}/sandbox-proof/run.env`
      ),
    ],
    // The live release record a failed removal left.
    [
      "release record",
      listing(
        "^storage ls -r",
        `${emptiedState}\n${state}/workspace-release-record.sandbox.json`
      ),
    ],
    [
      "task queue",
      listing(
        "^tasks queues list",
        "workspace-paid-fulfillment-r45279064237-1"
      ),
    ],
    [
      "scheduler job",
      listing("^scheduler jobs list", "workspace-reservation-hold-sweep"),
    ],
    [
      "Artifact Registry repository",
      listing("^artifacts repositories list", "workspace"),
    ],
    [
      "Cloud Run revision",
      listing("^run revisions list", "workspace-api-00001-abc"),
    ],
    // No load balancer, NEG, Cloud Armor, certificate or exclusion of
    // any name, and no project-level invoker grant.
    [
      "forwarding rule",
      computeList("forwardingRules", {
        items: { global: { forwardingRules: [{ name: "legacy-http" }] } },
      }),
    ],
    [
      "Cloud Armor policy",
      computeList("securityPolicies", {
        items: { global: { securityPolicies: [{ name: "legacy-armor" }] } },
      }),
    ],
    [
      "sink exclusion",
      sinksPage(`projects/${projectId}`, [
        {
          name: "export",
          destination: "bigquery.googleapis.com/x",
          exclusions: [{ name: "drop-noise", filter: "severity<INFO" }],
        },
      ]),
    ],
    [
      "project invoker grant",
      listing(
        "^projects get-iam-policy .*roles/run\\.invoker",
        "serviceAccount:stray"
      ),
    ],
  ] satisfies ReadonlyArray<readonly [string, FakeRule]>)(
    "finds a leftover %s by its bare ID",
    (_case, leftover) => {
      const { exitCode, output } = inventory([
        leftover,
        listing("^storage ls -r", emptiedState),
      ]);
      expect(exitCode).toBe(1);
      expect(output).toContain("proof resources remain");
    }
  );
});

describe("cleanup-only after run 45279064237", () => {
  test("tears down that run's stack with its recorded queues", () => {
    withProofFakes(
      {
        // What run 45279064237 left: its proof run record and a settled
        // release record with no writer lock.
        files: { "sandbox-proof/run.env": "QUEUE_SUFFIX=r45279064237-1\n" },
        status: settled(`sha256:${"2".repeat(64)}`),
        rules: [
          {
            tool: "gcloud",
            pattern: "^projects describe",
            stdout: "759037106024",
          },
          {
            tool: "gcloud",
            pattern: "^storage buckets describe",
            stdout: "EUROPE-WEST1",
          },
          {
            tool: "gcloud",
            pattern: "^storage ls -r",
            stdout: `gs://${stateBucket}/${stackPrefix}:\ngs://${stateBucket}/${lease}`,
          },
          ...readableLogging,
        ],
      },
      (fakes) => {
        const env = { SANDBOX_PROOF_MODE: "cleanup-only" };
        const preflight = runPhase(fakes, "preflight", env);
        expect(preflight.exitCode).toBe(0);
        const config = readFileSync(
          join(fakes.proofDir, "stack-config.json"),
          "utf8"
        );
        expect(config).toContain('"disposableQueueSuffix":"r45279064237-1"');
        const { exitCode, output } = runPhase(fakes, "cleanup-only", env);
        expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
          exitCode: 0,
          output: "",
        });
        const calls = fakes.calls();
        const destroy = calls.indexOf(
          "bun scripts/sandbox-locked-stack.ts destroy"
        );
        const removals = calls.flatMap((call, index) =>
          /^gcloud storage rm /.test(call) ? [index] : []
        );
        expect(destroy).toBeGreaterThan(-1);
        expect(removals.length).toBe(2);
        expect(removals.every((index) => index > destroy)).toBe(true);
        expect(fakes.world().files?.["sandbox-proof/run.env"]).toBeUndefined();
      }
    );
  }, 60_000);
});

describe("teardown deadline", () => {
  const deadline = Date.parse("2026-11-30T23:59:59Z") / 1000;
  const hour = 3600;
  const preflightRules: ReadonlyArray<FakeRule> = [
    { tool: "gcloud", pattern: "^projects describe", stdout: "759037106024" },
    {
      tool: "gcloud",
      pattern: "^storage buckets describe",
      stdout: "EUROPE-WEST1",
    },
  ];
  const preflight = (now: number, mode: string) =>
    withProofFakes({ now, rules: preflightRules }, (fakes) =>
      runPhase(fakes, "preflight", { SANDBOX_PROOF_MODE: mode })
    );

  test("lets hosted-proof start only a day before the deadline", () => {
    expect(preflight(deadline - 25 * hour, "hosted-proof").exitCode).toBe(0);
    const late = preflight(deadline - 23 * hour, "hosted-proof");
    expect(late.exitCode).toBe(1);
    expect(late.output).toContain("only cleanup-only may run now");
    expect(preflight(deadline + hour, "hosted-proof").exitCode).toBe(1);
  });

  test("keeps cleanup-only available after the deadline", () => {
    expect(preflight(deadline - 23 * hour, "cleanup-only").exitCode).toBe(0);
    const expired = preflight(deadline + 48 * hour, "cleanup-only");
    expect(expired.exitCode).toBe(0);
    expect(expired.output).toContain("teardown deadline has passed");
  });
});

describe("disposable queue IDs", () => {
  /** The disposable queue suffix the stack config the runner wrote declares. */
  const queueSuffixOf = (fakes: ProofFakes) =>
    Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          disposableQueueSuffix: Schema.optionalKey(Schema.String),
        })
      )
    )(readFileSync(join(fakes.proofDir, "stack-config.json"), "utf8"))
      .disposableQueueSuffix;

  const foundation = (runId: string) =>
    withProofFakes({}, (fakes) => {
      const { exitCode, output } = runPhase(fakes, "foundation", {
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: "2",
      });
      return {
        exitCode,
        output,
        suffix: queueSuffixOf(fakes),
        recorded: fakes.world().files?.["sandbox-proof/run.env"],
        calls: fakes.calls(),
      };
    });

  test("declare a fresh suffix per run and record it before the deploy", () => {
    const first = foundation("111");
    expect(first.exitCode).toBe(0);
    expect(first.suffix).toBe("r111-2");
    expect(first.recorded).toContain("QUEUE_SUFFIX=r111-2");
    const upload = first.calls.findIndex((call) =>
      call.includes("sandbox-proof/run.env")
    );
    const deploy = first.calls.findIndex((call) =>
      call.startsWith("bun release.run.ts deploy")
    );
    expect(upload).toBeGreaterThan(-1);
    expect(upload).toBeLessThan(deploy);
    expect(foundation("112").suffix).toBe("r112-2");
  });

  test("never executes the recorded proof run file", () => {
    for (const record of [
      "QUEUE_SUFFIX=r111-2\ntouch pwned\n",
      "QUEUE_SUFFIX=$(touch pwned)\n",
      "QUEUE_SUFFIX=r111-2;touch_pwned\n",
      // A valid suffix cannot smuggle in another setting.
      "QUEUE_SUFFIX=r111-2\nSANDBOX_PROOF_MODE=cleanup-only\n",
      "QUEUE_SUFFIX=r111-2\nQUEUE_SUFFIX=r112-1\n",
    ]) {
      withProofFakes(
        {
          files: { "sandbox-proof/run.env": record },
          rules: [
            {
              tool: "gcloud",
              pattern: "^projects describe",
              stdout: "759037106024",
            },
            {
              tool: "gcloud",
              pattern: "^storage buckets describe",
              stdout: "europe-west1",
            },
          ],
        },
        (fakes) => {
          const { exitCode, output } = runPhase(fakes, "preflight", {
            SANDBOX_PROOF_MODE: "cleanup-only",
          });
          expect({ record, exitCode }).toEqual({ record, exitCode: 1 });
          expect(output).toContain("not exactly one valid QUEUE_SUFFIX");
          expect(
            existsSync(join(packageRoot, "pwned")) ||
              existsSync(join(fakes.proofDir, "pwned"))
          ).toBe(false);
        }
      );
    }
  });

  test("reuse the recorded suffix in a later cleanup-only run", () => {
    withProofFakes(
      {
        files: { "sandbox-proof/run.env": "QUEUE_SUFFIX=r111-2\n" },
        rules: [
          {
            tool: "gcloud",
            pattern: "^projects describe",
            stdout: "759037106024",
          },
          {
            tool: "gcloud",
            pattern: "^storage buckets describe",
            stdout: "europe-west1",
          },
        ],
      },
      (fakes) => {
        const { exitCode } = runPhase(fakes, "preflight", {
          SANDBOX_PROOF_MODE: "cleanup-only",
        });
        expect(exitCode).toBe(0);
        expect(queueSuffixOf(fakes)).toBe("r111-2");
      }
    );
  });
});

describe("state snapshot and restore", () => {
  const stateWorld = (): FakeWorld => ({
    listNoncurrent: true,
    nextGeneration: 100,
    objects: {
      [`${stackPrefix}Service.json`]: {
        live: "5",
        generations: { "3": "crc-service-3", "5": "crc-service-5" },
      },
      [`${stackPrefix}Queue.json`]: {
        live: "7",
        generations: { "6": "crc-queue-6", "7": "crc-queue-7" },
      },
      [lease]: { live: "9", generations: { "9": "crc-lease" } },
    },
  });
  const locked = { WORKSPACE_RELEASE_WRITER: "fake-writer" };
  const manifest = (fakes: ProofFakes, file: string): unknown =>
    JSON.parse(readFileSync(join(fakes.proofDir, file), "utf8"));

  test("snapshots one live generation per object despite noncurrent history", () => {
    withProofFakes(stateWorld(), (fakes) => {
      const { exitCode, output } = runPhase(
        fakes,
        "state-snapshot-locked",
        locked
      );
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      expect(manifest(fakes, "state-live.json")).toEqual([
        {
          name: `${stackPrefix}Queue.json`,
          generation: "7",
          crc32c: "crc-queue-7",
        },
        {
          name: `${stackPrefix}Service.json`,
          generation: "5",
          crc32c: "crc-service-5",
        },
      ]);
    });
  });

  test("fails on an unreadable object instead of leaving it out", () => {
    // A credential error worded like a missing object, on a live object.
    const credentialError: FakeRule = {
      tool: "curl",
      pattern: "storage\\.googleapis\\.com/storage/v1/b/.*Queue\\.json",
      stdout:
        '{"error":{"code":401,"message":"credential file not found"}}\n401',
    };
    withProofFakes({ ...stateWorld(), rules: [credentialError] }, (fakes) => {
      const snapshot = runPhase(fakes, "state-snapshot-locked", locked);
      expect(snapshot.exitCode).toBe(1);
      expect(snapshot.output).toContain("Queue.json is unreadable");

      seed(fakes, {
        "state-snapshot.json": JSON.stringify([
          {
            name: `${stackPrefix}Service.json`,
            generation: "3",
            crc32c: "crc-service-3",
          },
        ]),
      });
      const restore = runPhase(fakes, "state-restore-locked", locked);
      expect(restore.exitCode).toBe(1);
      expect(restore.output).toContain("Queue.json is unreadable");
      const writes = fakes
        .calls()
        .filter((call) => /^gcloud storage (cp|rm) /.test(call));
      expect(writes).toEqual([]);
      expect(fakes.world().objects?.[`${stackPrefix}Queue.json`]?.live).toBe(
        "7"
      );
    });
  });

  test("refuses to snapshot or restore without the writer lock", () => {
    withProofFakes(stateWorld(), (fakes) => {
      for (const phase of ["state-snapshot-locked", "state-restore-locked"]) {
        const { exitCode, output } = runPhase(fakes, phase);
        expect(exitCode).toBe(1);
        expect(output).toContain("runs only under the writer lock");
      }
      expect(fakes.calls()).toEqual([]);
    });
  });

  test("restores the snapshot generations and verifies the live objects", () => {
    withProofFakes(stateWorld(), (fakes) => {
      expect(runPhase(fakes, "state-snapshot-locked", locked).exitCode).toBe(0);
      seed(fakes, {
        "state-snapshot.json": readFileSync(
          join(fakes.proofDir, "state-live.json"),
          "utf8"
        ),
      });
      // A tracked change: one object rewritten, one removed, one added.
      const world = fakes.world();
      const objects = { ...world.objects };
      objects[`${stackPrefix}Service.json`] = {
        live: "11",
        generations: {
          "3": "crc-service-3",
          "5": "crc-service-5",
          "11": "crc-service-11",
        },
      };
      objects[`${stackPrefix}Queue.json`] = {
        live: null,
        generations: { "6": "crc-queue-6", "7": "crc-queue-7" },
      };
      objects[`${stackPrefix}Extra.json`] = {
        live: "12",
        generations: { "12": "crc-extra" },
      };
      writeFileSync(
        fakes.env.FAKE_WORLD ?? "",
        JSON.stringify({ ...world, objects })
      );

      const { exitCode, output } = runPhase(
        fakes,
        "state-restore-locked",
        locked
      );
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      const restored = fakes.world().objects ?? {};
      const liveCrc = (name: string) => {
        const object = restored[`${stackPrefix}${name}`];
        return object?.live == null ? null : object.generations[object.live];
      };
      expect(liveCrc("Service.json")).toBe("crc-service-5");
      expect(liveCrc("Queue.json")).toBe("crc-queue-7");
      expect(liveCrc("Extra.json")).toBeNull();
      expect(restored[lease]?.live).toBe("9");
      const writes = fakes
        .calls()
        .filter((call) => / storage (cp|rm) /.test(` ${call}`));
      expect(writes).toEqual([
        `gcloud storage cp gs://${stateBucket}/${stackPrefix}Queue.json#7 gs://${stateBucket}/${stackPrefix}Queue.json --if-generation-match=0`,
        `gcloud storage cp gs://${stateBucket}/${stackPrefix}Service.json#5 gs://${stateBucket}/${stackPrefix}Service.json --if-generation-match=11`,
        `gcloud storage rm gs://${stateBucket}/${stackPrefix}Extra.json --if-generation-match=12`,
      ]);
    });
  });

  test("fails when a restored object does not read back as the snapshot", () => {
    withProofFakes(stateWorld(), (fakes) => {
      expect(runPhase(fakes, "state-snapshot-locked", locked).exitCode).toBe(0);
      const [first, ...rest] = Schema.decodeUnknownSync(
        Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
      )(manifest(fakes, "state-live.json"));
      if (first === undefined) {
        throw new Error("expected the snapshot to list an object");
      }
      const altered = [{ ...first, crc32c: "crc-never-written" }, ...rest];
      seed(fakes, { "state-snapshot.json": JSON.stringify(altered) });
      const { exitCode, output } = runPhase(
        fakes,
        "state-restore-locked",
        locked
      );
      expect(exitCode).toBe(1);
      expect(output).toContain("do not match the snapshot");
    });
  });
});

describe("interrupting a deliver mid-apply", () => {
  const interruptWorld = (
    behaviour: NonNullable<FakeWorld["interruptedDeliver"]>
  ): FakeWorld => ({
    interruptedDeliver: behaviour,
    serviceGenerations: {
      "workspace-api": 4,
      "workspace-tasks-worker": 2,
      "workspace-scheduler-worker": 2,
    },
    status: settled(`sha256:${"2".repeat(64)}`),
    rules: [
      {
        tool: "bun",
        pattern: `^release\\.run\\.ts unlock --holder ${fakeWriterFingerprint}$`,
        set: { status: settled(`sha256:${"2".repeat(64)}`) },
      },
      {
        tool: "bun",
        pattern: "^release\\.run\\.ts plan$",
        stdout: "Plan: no changes",
      },
    ],
  });
  const seedDeliver = (fakes: ProofFakes) =>
    seed(fakes, {
      "stack-config.json": "{}",
      "digests.env": `PROBE_V3_DIGEST=${v3Digest}\n`,
    });

  test("kills the apply's detached child before unlocking and redelivers", () => {
    withProofFakes(interruptWorld("apply"), (fakes) => {
      seedDeliver(fakes);
      // The rerun deliver, without the interrupt token, settles v3.
      const world = fakes.world();
      writeFileSync(
        fakes.env.FAKE_WORLD ?? "",
        JSON.stringify({
          ...world,
          rules: [
            ...(world.rules ?? []),
            {
              tool: "bun",
              pattern: "^release\\.run\\.ts deliver .*--image-digest",
              set: { status: settled(v3Digest) },
            },
          ],
        })
      );
      const { exitCode, output } = runPhase(fakes, "interrupt-recover");
      const child = fakes.world().detachedChildPid;
      expect(child).toBeNumber();
      const alive = child === undefined ? false : isAlive(child);
      if (alive && child !== undefined) {
        process.kill(child, "SIGKILL");
      }
      expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
        exitCode: 0,
        output: "",
      });
      expect(alive).toBe(false);
      const calls = fakes.calls();
      const unlock = calls.findIndex((call) =>
        call.startsWith(
          `bun release.run.ts unlock --holder ${fakeWriterFingerprint}`
        )
      );
      const redeliver = calls.findLastIndex((call) =>
        call.startsWith("bun release.run.ts deliver")
      );
      expect(unlock).toBeGreaterThan(-1);
      expect(redeliver).toBeGreaterThan(unlock);
    });
  });

  test("leaves a lock another writer took after the deliver was killed", () => {
    const world = interruptWorld("apply");
    withProofFakes(
      {
        ...world,
        rules: [
          // By the lease check after the kill, another writer holds the lock.
          {
            tool: "curl",
            pattern: "storage\\.googleapis\\.com/storage/v1/b/.*__lease__",
            stdout: '{"generation":"9"}\n200',
            set: {
              status: {
                version: "1",
                record: {
                  generation: 8,
                  writer: { holder: "0123456789ab" },
                  pendingApply: null,
                },
              },
            },
          },
          ...(world.rules ?? []),
        ],
      },
      (fakes) => {
        seedDeliver(fakes);
        const { exitCode, output } = runPhase(fakes, "interrupt-recover");
        const child = fakes.world().detachedChildPid;
        if (child !== undefined && isAlive(child)) {
          process.kill(child, "SIGKILL");
        }
        expect(exitCode).toBe(1);
        expect(output).toContain("not the killed deliver");
        expect(fakes.calls().join("\n")).not.toContain("unlock");
      }
    );
  });

  test("fails without a baseline generation read", () => {
    const world = interruptWorld("apply");
    withProofFakes(
      {
        ...world,
        rules: [
          {
            tool: "gcloud",
            pattern: "^run services describe workspace-api ",
            exit: 1,
          },
          ...(world.rules ?? []),
        ],
      },
      (fakes) => {
        seedDeliver(fakes);
        const { exitCode, output } = runPhase(fakes, "interrupt-recover");
        expect(exitCode).toBe(1);
        expect(output).toContain("the interrupt has no baseline");
        expect(fakes.calls().join("\n")).not.toContain("deliver");
      }
    );
  });

  test("never counts a failed generation read as a change", () => {
    withProofFakes(
      {
        ...interruptWorld("exit-after-failed-read"),
        serviceReadsFailAfterDeliver: true,
      },
      (fakes) => {
        seedDeliver(fakes);
        const { exitCode, output } = runPhase(fakes, "interrupt-recover");
        expect(fakes.world().failedServiceReads).toBeGreaterThan(0);
        expect(exitCode).toBe(1);
        expect(output).toContain("persisted no Cloud Run change");
        expect(fakes.calls().join("\n")).not.toContain("unlock");
      }
    );
  });

  test("fails when the deliver ends before persisting any change", () => {
    withProofFakes(interruptWorld("exit"), (fakes) => {
      seedDeliver(fakes);
      const { exitCode, output } = runPhase(fakes, "interrupt-recover");
      expect(exitCode).toBe(1);
      expect(output).toContain("persisted no Cloud Run change");
      expect(fakes.calls().join("\n")).not.toContain("unlock");
    });
  });
});

describe("Alchemy access token", () => {
  // Every Alchemy phase must start with the stack destroy's 30-minute
  // budget left on the token it hands Alchemy.
  const now = 1_800_000_000;
  const lifetime = (seconds: number): FakeRule => ({
    tool: "curl",
    pattern: "oauth2\\.googleapis\\.com/tokeninfo",
    stdout: JSON.stringify({ expires_in: String(seconds) }),
  });
  const run = (
    phases: string | ReadonlyArray<string>,
    expiresIn: number,
    rules: ReadonlyArray<FakeRule> = [lifetime(3599)]
  ) =>
    withProofFakes({ now, rules }, (fakes) => {
      const result = runPhase(fakes, phases, {
        GOOGLE_ACCESS_TOKEN_EXPIRES_AT: String(now + expiresIn),
        GITHUB_ACTIONS: "true",
      });
      return {
        ...result,
        // A minted token is masked before any use.
        mints: result.output.split("::add-mask::").length - 1,
        calls: fakes.calls(),
      };
    });

  test("mints a fresh token once under 30 minutes remain", () => {
    for (const [left, mints] of [
      [1800, 0],
      [1799, 1],
    ] as const) {
      const result = run("foundation", left);
      expect({ left, exitCode: result.exitCode, mints: result.mints }).toEqual({
        left,
        exitCode: 0,
        mints,
      });
    }
  });

  test("verifies the workflow's token by its own remaining lifetime", () => {
    // However long ago the auth step minted it, only tokeninfo decides.
    for (const [left, mints] of [
      [3000, 0],
      [1790, 1],
      [undefined, 1],
    ] as const) {
      const { exitCode, output } = withProofFakes(
        {
          now,
          tokenLifetimes:
            left === undefined
              ? { "fake-access-token": 3599 }
              : { "fake-access-token": 3599, "workflow-token": left },
        },
        (fakes) =>
          runPhase(fakes, "foundation", {
            GOOGLE_ACCESS_TOKEN: "workflow-token",
            GOOGLE_ACCESS_TOKEN_EXPIRES_AT: "",
            GITHUB_ACTIONS: "true",
          })
      );
      expect({
        left,
        exitCode,
        mints: output.split("::add-mask::").length - 1,
      }).toEqual({ left, exitCode: 0, mints });
    }
  });

  test("counts a slow tokeninfo reply against the token", () => {
    // Each reply takes 5 s, so a reported 1801 s or 1803 s leaves less
    // than 30 minutes once it arrives.
    const withLifetimes = (lifetimes: Record<string, number>) =>
      withProofFakes(
        { now, tokenLifetimes: lifetimes, tokeninfoDelay: 5 },
        (fakes) => {
          const result = runPhase(fakes, "foundation", {
            GOOGLE_ACCESS_TOKEN: "workflow-token",
            GOOGLE_ACCESS_TOKEN_EXPIRES_AT: "",
            GITHUB_ACTIONS: "true",
          });
          return {
            exitCode: result.exitCode,
            mints: result.output.split("::add-mask::").length - 1,
          };
        }
      );
    // The workflow's token is replaced, and the fresh one accepted.
    expect(
      withLifetimes({ "workflow-token": 1801, "fake-access-token": 3599 })
    ).toEqual({ exitCode: 0, mints: 1 });
    // A fresh token short of 30 minutes on arrival is refused.
    expect(withLifetimes({ "fake-access-token": 1803 })).toEqual({
      exitCode: 1,
      mints: 1,
    });
  });

  test("refreshes between phases of one run by the token's real expiry", () => {
    // The minted token has 1805 s; the first deploy takes 600 s of it.
    const { exitCode, mints } = run(["foundation", "foundation"], 0, [
      lifetime(1805),
      { tool: "bun", pattern: "^release\\.run\\.ts deploy", advance: 600 },
    ]);
    expect({ exitCode, mints }).toEqual({ exitCode: 0, mints: 2 });
  });

  test("refuses a token with less than 30 minutes left", () => {
    for (const rules of [[lifetime(600)], []]) {
      const { exitCode, output, calls } = run("foundation", 0, rules);
      expect({
        exitCode,
        refused: output.includes("access token"),
        deployed: calls.some((call) => call.includes("release.run.ts deploy")),
      }).toEqual({ exitCode: 1, refused: true, deployed: false });
    }
  });

  test("prints no minted token outside GitHub Actions", () => {
    const output = withProofFakes({ now, rules: [lifetime(3599)] }, (fakes) =>
      runPhase(fakes, "foundation", {
        GOOGLE_ACCESS_TOKEN_EXPIRES_AT: String(now + 60),
      })
    ).output;
    expect(output).not.toContain("fake-access-token");
  });

  test("takes the inventories even when no token can be verified", () => {
    for (const phase of ["baseline-inventory", "post-destroy-inventory"]) {
      const { exitCode, mints, calls } = run(phase, 0, [...readableLogging]);
      expect({
        phase,
        exitCode,
        mints,
        listed: calls.includes(
          "gcloud run services list --project=deskohub-workspace-sandbox --region=europe-west1 --format=value(metadata.name)"
        ),
      }).toEqual({ phase, exitCode: 0, mints: 0, listed: true });
    }
  });
});

// ------------------------------------------- the IAM-private service phases

const apiUrl = fakeServiceUrl("workspace-api");
const tasksWorkerUrl = fakeServiceUrl("workspace-tasks-worker");
const schedulerWorkerUrl = fakeServiceUrl("workspace-scheduler-worker");
const serviceAccount = (name: string) =>
  [name, `${projectId}.iam.gserviceaccount.com`].join("@");
const deployer = serviceAccount("workspace-deployer");

const seedServices = (fakes: ProofFakes) =>
  seed(fakes, {
    "services.env": [
      `API_URL=${apiUrl}`,
      `TASKS_WORKER_URL=${tasksWorkerUrl}`,
      `SCHEDULER_WORKER_URL=${schedulerWorkerUrl}`,
      "",
    ].join("\n"),
  });

/**
 * A marker as the primary RPC probe leaves it: in the private directory,
 * with its digest recorded.
 */
const seedMarker = (fakes: ProofFakes, recorded?: string) => {
  const marker = `sandbox-marker-${"ab".repeat(16)}`;
  const sha = createHash("sha256").update(marker).digest("hex");
  mkdirSync(fakes.privateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(fakes.privateDir, "marker"), marker);
  appendFileSync(
    join(fakes.proofDir, "telemetry.env"),
    `MARKER_SHA256=${recorded ?? sha}\n`
  );
  return { marker, sha };
};

/** Lines that show the marker: none, outside GitHub Actions. */
const markerLeaks = (output: string, marker: string) =>
  output.split("\n").filter((line) => line.includes(marker));

/** An unsigned JWT with the given claims, as the ID token's stand-in. */
const idToken = (claims: Schema.JsonObject) =>
  [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");

describe("first deliver", () => {
  const deliverWorld = (rules: ReadonlyArray<FakeRule> = []): FakeWorld => ({
    status: settled(v1Digest),
    rules: [
      ...rules,
      {
        tool: "bun",
        pattern: "^release\\.run\\.ts plan$",
        stdout: "no changes",
      },
    ],
  });
  const deliver = (rules: ReadonlyArray<FakeRule> = []) =>
    withProofFakes(deliverWorld(rules), (fakes) => {
      seed(fakes, {
        "stack-config.json": "{}",
        "digests.env": `PROBE_V1_DIGEST=${v1Digest}\n`,
      });
      const githubOutput = join(fakes.proofDir, "github-output");
      const result = runPhase(fakes, "deliver-v1", {
        GITHUB_OUTPUT: githubOutput,
        SANDBOX_SERVING_TIMEOUT_SECONDS: "20",
      });
      const read = (path: string) =>
        existsSync(path) ? readFileSync(path, "utf8") : "";
      return {
        ...result,
        services: read(join(fakes.proofDir, "services.env")),
        githubOutput: read(githubOutput),
      };
    });

  test("records each service URL and hands workspace-api's to the workflow", () => {
    const { exitCode, output, services, githubOutput } = deliver();
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(services).toContain(`API_URL=${apiUrl}`);
    expect(services).toContain(`TASKS_WORKER_URL=${tasksWorkerUrl}`);
    expect(services).toContain(`SCHEDULER_WORKER_URL=${schedulerWorkerUrl}`);
    expect(githubOutput).toBe(`api_url=${apiUrl}\n`);
  });

  test("fails while any service sends traffic to another build", () => {
    const { exitCode, output } = deliver([
      {
        tool: "gcloud",
        pattern: "^run revisions describe workspace-tasks-worker-live ",
        stdout: `europe-west1-docker.pkg.dev/x/workspace/workspace@sha256:${"2".repeat(64)}`,
      },
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "workspace-tasks-worker did not send all its traffic to Ready revisions of probe v1"
    );
  });

  test("fails when a service does not report its deterministic URL", () => {
    const { exitCode, output } = deliver([
      {
        tool: "gcloud",
        pattern:
          "^run services describe workspace-tasks-worker .*--format=json$",
        stdout: JSON.stringify({
          metadata: {
            annotations: {
              "run.googleapis.com/urls": JSON.stringify([
                "https://workspace-tasks-worker-a1b2c3d4e5-ew.a.run.app",
              ]),
            },
          },
          status: {
            url: "https://workspace-tasks-worker-a1b2c3d4e5-ew.a.run.app",
          },
        }),
      },
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      `workspace-tasks-worker does not report its deterministic URL ${tasksWorkerUrl}`
    );
  });

  test("fails when one of two serving revisions runs another build", () => {
    const { exitCode, output } = deliver([
      {
        tool: "gcloud",
        pattern: "^run services describe workspace-api .*--format=json$",
        stdout: JSON.stringify({
          metadata: { generation: 2 },
          status: {
            url: apiUrl,
            observedGeneration: 2,
            conditions: [{ type: "Ready", status: "True" }],
            traffic: [
              { revisionName: "workspace-api-live", percent: 90 },
              { revisionName: "workspace-api-old", percent: 10 },
            ],
          },
        }),
      },
      {
        tool: "gcloud",
        pattern: "^run revisions describe workspace-api-old ",
        stdout: `europe-west1-docker.pkg.dev/x/workspace/workspace@sha256:${"2".repeat(64)}`,
      },
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("workspace-api did not send all its traffic");
  });

  test("fails until the service has observed its latest generation", () => {
    const { exitCode, output } = deliver([
      {
        tool: "gcloud",
        pattern:
          "^run services describe workspace-scheduler-worker .*--format=json$",
        stdout: JSON.stringify({
          metadata: { generation: 3 },
          status: {
            url: schedulerWorkerUrl,
            observedGeneration: 2,
            conditions: [{ type: "Ready", status: "True" }],
            traffic: [
              { revisionName: "workspace-scheduler-worker-live", percent: 100 },
            ],
          },
        }),
      },
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "workspace-scheduler-worker did not send all its traffic"
    );
  });

  test("accepts a bare image digest", () => {
    const { exitCode, output } = deliver([
      {
        tool: "gcloud",
        pattern: "^run revisions describe workspace-api-live ",
        stdout: v1Digest,
      },
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  });

  test("fails while a service is not Ready", () => {
    const { exitCode, output } = deliver([
      {
        tool: "gcloud",
        pattern: "^run services describe workspace-api .*--format=json$",
        stdout: JSON.stringify({
          metadata: { generation: 2 },
          status: {
            url: apiUrl,
            observedGeneration: 2,
            conditions: [{ type: "Ready", status: "False" }],
            traffic: [{ revisionName: "workspace-api-live", percent: 100 }],
          },
        }),
      },
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("workspace-api did not send all its traffic");
  });
});

describe("private access", () => {
  const policy = (members: ReadonlyArray<string>) =>
    JSON.stringify({
      bindings: [{ role: "roles/run.invoker", members }],
    });
  const status = (pattern: string, code: string): FakeRule => ({
    tool: "curl",
    pattern,
    stdout: code,
  });
  const baseRules: ReadonlyArray<FakeRule> = [
    status("Authorization: Bearer garbage", "401"),
    status(
      "workspace-(api|tasks-worker|scheduler-worker)-[^ ]*/(health|rpc|api/.*)$",
      "403"
    ),
    {
      tool: "gcloud",
      pattern: "^run services get-iam-policy workspace-api ",
      stdout: policy([
        `serviceAccount:${serviceAccount("workspace-frontend-preview")}`,
        `serviceAccount:${deployer}`,
      ]),
    },
    {
      tool: "gcloud",
      pattern: "^run services get-iam-policy workspace-tasks-worker ",
      stdout: policy([
        `serviceAccount:${serviceAccount("workspace-tasks-invoker")}`,
      ]),
    },
    {
      tool: "gcloud",
      pattern: "^run services get-iam-policy workspace-scheduler-worker ",
      stdout: policy([
        `serviceAccount:${serviceAccount("workspace-scheduler-invoker")}`,
      ]),
    },
    {
      tool: "gcloud",
      pattern: "^projects get-iam-policy ",
      stdout: JSON.stringify({
        bindings: [
          { role: "roles/viewer", members: [`serviceAccount:${deployer}`] },
        ],
      }),
    },
  ];
  const access = (overrides: ReadonlyArray<FakeRule> = []) =>
    withProofFakes({ rules: [...overrides, ...baseRules] }, (fakes) => {
      seedServices(fakes);
      return {
        ...runPhase(fakes, "private-access", {
          GCP_SANDBOX_DEPLOY_SA: deployer,
        }),
        calls: fakes.calls(),
      };
    });

  test("passes when every service refuses callers without the invoker role", () => {
    const { exitCode, output, calls } = access();
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
    for (const url of [apiUrl, tasksWorkerUrl, schedulerWorkerUrl]) {
      expect(calls).toContain(
        `curl -sS -o /dev/null -w %{http_code} --max-time 20 -X GET ${url}/health`
      );
      expect(calls).toContain(
        `curl -sS -o /dev/null -w %{http_code} --max-time 20 -X POST --data-binary  ${url}/rpc`
      );
      // Each service, workers included, rejects a malformed bearer itself.
      expect(calls).toContainEqual(
        expect.stringMatching(
          new RegExp(`Authorization: Bearer garbage .*${url}/rpc$`)
        )
      );
    }
  });

  test("fails on any served request, or a refusal of the wrong kind", () => {
    for (const [rule, message] of [
      [
        status("workspace-api-[^ ]*/health$", "200"),
        "unauthenticated GET /health on workspace-api was served (HTTP 200)",
      ],
      [
        status("workspace-tasks-worker-[^ ]*/rpc$", "204"),
        "unauthenticated POST /rpc on workspace-tasks-worker was served",
      ],
      [
        status(
          "workspace-tasks-worker-[^ ]*/api/queues/workspace/paid-fulfillment$",
          "204"
        ),
        "unauthenticated POST /api/queues/workspace/paid-fulfillment on workspace-tasks-worker was served",
      ],
      [
        status(
          "workspace-scheduler-worker-[^ ]*/api/cron/workspace/proof-tick$",
          "204"
        ),
        "unauthenticated GET /api/cron/workspace/proof-tick on workspace-scheduler-worker was served",
      ],
      [
        status("workspace-api-[^ ]*/rpc$", "404"),
        "unauthenticated POST /rpc on workspace-api: HTTP 404, expected 403",
      ],
      [
        // Ingress refusing a worker proves nothing about IAM.
        status("workspace-scheduler-worker-[^ ]*/health$", "404"),
        "unauthenticated GET /health on workspace-scheduler-worker: HTTP 404, expected 403",
      ],
      [
        status("Authorization: Bearer garbage", "403"),
        "POST /rpc with a garbage bearer on workspace-api: HTTP 403, expected 401",
      ],
      [
        status("Bearer garbage.*workspace-tasks-worker-", "403"),
        "POST /rpc with a garbage bearer on workspace-tasks-worker: HTTP 403, expected 401",
      ],
      [
        { tool: "curl", pattern: "workspace-api-[^ ]*/health$", exit: 7 },
        "HTTP 000",
      ],
    ] as const) {
      const { exitCode, output } = access([rule]);
      expect({ message, exitCode }).toEqual({ message, exitCode: 1 });
      expect(output).toContain(message);
    }
  });

  describe("fails on a public member, a disabled invoker check or missing invokers", () => {
    for (const [rule, message] of [
      [
        {
          tool: "gcloud",
          pattern: "^run services get-iam-policy workspace-scheduler-worker ",
          stdout: policy(["allUsers"]),
        },
        "workspace-scheduler-worker grants allUsers or allAuthenticatedUsers",
      ],
      [
        {
          tool: "gcloud",
          pattern: "^run services get-iam-policy workspace-tasks-worker ",
          stdout: policy(["allAuthenticatedUsers"]),
        },
        "workspace-tasks-worker grants allUsers",
      ],
      [
        {
          tool: "gcloud",
          pattern: "^run services describe workspace-api .*--format=json$",
          stdout: JSON.stringify({
            metadata: {
              annotations: {
                "run.googleapis.com/invoker-iam-disabled": "true",
              },
            },
          }),
        },
        "workspace-api has the invoker IAM check disabled",
      ],
      [
        {
          tool: "gcloud",
          pattern: "^run services get-iam-policy workspace-api ",
          stdout: policy([`serviceAccount:${deployer}`]),
        },
        "workspace-api does not grant roles/run.invoker unconditionally to exactly",
      ],
      [
        {
          tool: "gcloud",
          pattern: "^run services get-iam-policy workspace-tasks-worker ",
          stdout: policy([
            `serviceAccount:${serviceAccount("workspace-tasks-invoker")}`,
            `serviceAccount:${deployer}`,
          ]),
        },
        "workspace-tasks-worker does not grant roles/run.invoker unconditionally to exactly",
      ],
      [
        {
          tool: "gcloud",
          pattern: "^run services get-iam-policy workspace-scheduler-worker ",
          stdout: JSON.stringify({
            bindings: [
              {
                role: "roles/run.invoker",
                members: [
                  `serviceAccount:${serviceAccount("workspace-scheduler-invoker")}`,
                ],
                condition: {
                  expression:
                    "request.time < timestamp('2000-01-01T00:00:00Z')",
                },
              },
            ],
          }),
        },
        "workspace-scheduler-worker does not grant roles/run.invoker unconditionally",
      ],
      [
        {
          tool: "gcloud",
          pattern:
            "^run services describe workspace-tasks-worker .*--format=json$",
          stdout: JSON.stringify({
            metadata: {
              annotations: { "run.googleapis.com/ingress": "internal" },
            },
          }),
        },
        "workspace-tasks-worker does not have ingress all",
      ],
      [
        {
          tool: "gcloud",
          pattern:
            "^run services describe workspace-scheduler-worker .*--format=json$",
          stdout: JSON.stringify({
            metadata: {
              annotations: {
                "run.googleapis.com/ingress": "all",
                "run.googleapis.com/ingress-status": "internal",
              },
            },
          }),
        },
        "workspace-scheduler-worker does not have ingress all, requested and active",
      ],
      [
        {
          tool: "gcloud",
          pattern: "^projects get-iam-policy ",
          stdout: JSON.stringify({
            bindings: [
              {
                role: "roles/run.invoker",
                members: [`serviceAccount:${deployer}`],
              },
            ],
          }),
        },
        "the project grants roles/run.invoker or a public member at project level",
      ],
      [
        {
          tool: "gcloud",
          pattern: "^run services get-iam-policy workspace-api ",
          exit: 1,
        },
        "the IAM policy of workspace-api is unreadable",
      ],
    ] as const) {
      test(message, () => {
        const { exitCode, output } = access([rule]);
        expect(exitCode).toBe(1);
        expect(output).toContain(message);
      });
    }
  });
});

describe("RPC probe", () => {
  const now = 1_800_000_000;
  const probe = (
    world: FakeWorld = { rpcVerdict: {} },
    claims: Schema.JsonObject = { aud: apiUrl, exp: now + 3000 }
  ) =>
    withProofFakes({ now, ...world }, (fakes) => {
      seedServices(fakes);
      const token = idToken(claims);
      const result = runPhase(fakes, "rpc-probe", {
        SANDBOX_API_ID_TOKEN: token,
      });
      const markerFile = join(fakes.privateDir, "marker");
      const telemetry = join(fakes.proofDir, "telemetry.env");
      return {
        ...result,
        marker: existsSync(markerFile) ? readFileSync(markerFile, "utf8") : "",
        token,
        calls: fakes.calls(),
        verdictKept: existsSync(join(fakes.proofDir, "rpc-probe-primary.json")),
        telemetry: existsSync(telemetry) ? readFileSync(telemetry, "utf8") : "",
        tokenFileLeft: existsSync(join(fakes.privateDir, "api-id-token")),
        privateMode: existsSync(fakes.privateDir)
          ? statSync(fakes.privateDir).mode & 0o777
          : null,
      };
    });

  test("passes on a SchemaBinary verdict for a fresh marker and records its trace", () => {
    const result = probe();
    expect({
      exitCode: result.exitCode,
      output: result.exitCode === 0 ? "" : result.output,
    }).toEqual({ exitCode: 0, output: "" });
    const call = result.calls.find((line) =>
      line.startsWith("bun scripts/sandbox-rpc-probe.ts")
    );
    expect(call).toMatch(
      new RegExp(
        `^bun scripts/sandbox-rpc-probe\\.ts --url ${apiUrl} --id-token-file \\S+/api-id-token --marker-file \\S+/marker --traceparent 00-[0-9a-f]{32}-[0-9a-f]{16}-01 --expect-version v1 --email-preferences$`
      )
    );
    const traceparent = call?.match(/00-([0-9a-f]{32})-/)?.[1];
    expect(result.marker).toMatch(/^sandbox-marker-[0-9a-f]{32}$/);
    const sha = createHash("sha256").update(result.marker).digest("hex");
    expect(result.telemetry).toBe(
      `PROBE_STARTED_AT=${now}\nPROBE_TRACE_ID=${traceparent}\nMARKER_SHA256=${sha}\n`
    );
    expect(result.verdictKept).toBe(true);
    expect(result.tokenFileLeft).toBe(false);
    expect(result.privateMode).toBe(0o700);
    expect(result.output).not.toContain(result.token);
    expect(markerLeaks(result.output, result.marker)).toEqual([]);
  });

  test("masks the marker only inside GitHub Actions", () => {
    const masked = withProofFakes({ now, rpcVerdict: {} }, (fakes) => {
      seedServices(fakes);
      const { output } = runPhase(fakes, "rpc-probe", {
        SANDBOX_API_ID_TOKEN: idToken({ aud: apiUrl, exp: now + 3000 }),
        GITHUB_ACTIONS: "true",
      });
      return {
        output,
        marker: readFileSync(join(fakes.privateDir, "marker"), "utf8"),
      };
    });
    expect(masked.output).toContain(`::add-mask::${masked.marker}`);
  });

  test("fails on any verdict short of the full RPC contract", () => {
    for (const [rpcVerdict, message] of [
      [{ status: 403, ok: false }, "HTTP 403"],
      [{ contentType: "application/json" }, "content type application/json"],
      [{ markerSha256: "0".repeat(64) }, "markerSha256 does not match"],
      [{ markerMatches: false }, "markerSha256 does not match"],
      [{ failDecoded: null }, "Probe.fail decoded as null"],
      [{ countChunks: [0, 1] }, "Probe.count yielded 2 chunks"],
      [{ emailPreferences: null }, "email preferences proof incomplete"],
      [{ version: "v2" }, "version v2"],
      [{ failures: ["count stream ended early"] }, "count stream ended early"],
    ] as const) {
      const { exitCode, output } = probe({ rpcVerdict });
      expect({ message, exitCode }).toEqual({ message, exitCode: 1 });
      expect(output).toContain(message);
    }
  });

  test("fails on a failing exit or an unreadable verdict", () => {
    const failed = probe({ rpcVerdict: { ok: false }, rpcExit: 1 });
    expect(failed.exitCode).toBe(1);
    expect(failed.output).toContain("the RPC probe failed (exit 1)");
    const garbled = probe({
      rules: [
        {
          tool: "bun",
          pattern: "^scripts/sandbox-rpc-probe\\.ts ",
          stdout: "not json",
        },
      ],
    });
    expect(garbled.exitCode).toBe(1);
    expect(garbled.output).toContain("printed no single JSON verdict");
  });

  test("keeps no verdict that shows the marker", () => {
    const leaked = probe({ rpcVerdict: {}, rpcPrintsMarker: true });
    expect(leaked.exitCode).toBe(1);
    expect(leaked.output).toContain("the RPC probe printed the marker");
    expect(leaked.verdictKept).toBe(false);
    expect(markerLeaks(leaked.output, leaked.marker)).toEqual([]);
  });

  test("refuses an ID token for another audience or near its expiry", () => {
    for (const [claims, message] of [
      [
        { aud: tasksWorkerUrl, exp: now + 3000 },
        "the ID token's audience is not the workspace-api URL",
      ],
      [{ aud: apiUrl, exp: now + 300 }, "expires in under 600 s"],
      [{ aud: apiUrl }, "expires in under 600 s"],
    ] as const) {
      const result = probe({ rpcVerdict: {} }, claims);
      expect({ message, exitCode: result.exitCode }).toEqual({
        message,
        exitCode: 1,
      });
      expect(result.output).toContain(message);
      expect(
        result.calls.some((line) => line.includes("sandbox-rpc-probe"))
      ).toBe(false);
      expect(result.tokenFileLeft).toBe(false);
    }
  });

  test("refuses to run without a minted ID token", () => {
    withProofFakes({}, (fakes) => {
      seedServices(fakes);
      const { exitCode, output } = runPhase(fakes, "rpc-probe");
      expect(exitCode).toBe(1);
      expect(output).toContain("no workspace-api ID token");
    });
  });

  test("keeps the private directory out of the uploaded proof directory", () => {
    withProofFakes({}, (fakes) => {
      seedServices(fakes);
      const { exitCode, output } = runPhase(fakes, "rpc-probe", {
        SANDBOX_PROOF_PRIVATE_DIR: join(fakes.proofDir, "private"),
        SANDBOX_API_ID_TOKEN: idToken({ aud: apiUrl, exp: 99_999_999_999 }),
      });
      expect(exitCode).toBe(1);
      expect(output).toContain("must lie outside the uploaded proof directory");
      expect(existsSync(join(fakes.proofDir, "private"))).toBe(false);
    });
  });

  test("leaves no usable marker record after a failed retry", () => {
    withProofFakes({ now, rpcVerdict: {} }, (fakes) => {
      seedServices(fakes);
      const env = {
        SANDBOX_API_ID_TOKEN: idToken({ aud: apiUrl, exp: now + 3000 }),
      };
      expect(runPhase(fakes, "rpc-probe", env).exitCode).toBe(0);
      writeFileSync(
        fakes.env.FAKE_WORLD ?? "",
        JSON.stringify({ now, rpcVerdict: { ok: false }, rpcExit: 1 })
      );
      expect(runPhase(fakes, "rpc-probe", env).exitCode).toBe(1);
      expect(existsSync(join(fakes.proofDir, "telemetry.env"))).toBe(false);
      seed(fakes, { "proof-run.env": "QUEUE_SUFFIX=r111-1\n" });
      const later = runPhase(fakes, "worker-probe");
      expect(later.exitCode).toBe(1);
      expect(later.output).toContain("not the one the rpc-probe phase sent");
    });
  });

  test("never sends a replacement for a lost marker in a later probe", () => {
    withProofFakes(
      { now, rpcVerdict: {}, status: settled(v1Digest) },
      (fakes) => {
        seedServices(fakes);
        seed(fakes, {
          "stack-config.json": "{}",
          "digests.env": `PROBE_V1_DIGEST=${v1Digest}\n`,
          "releases.env": "V1_RELEASE_ID=release-1\n",
        });
        // The marker file is gone; restore-v1's probe must not mint one.
        const { exitCode, output } = runPhase(fakes, "restore-v1", {
          SANDBOX_API_ID_TOKEN: idToken({ aud: apiUrl, exp: now + 3000 }),
        });
        expect(exitCode).toBe(1);
        expect(output).toContain("the run's marker is missing");
        expect(existsSync(join(fakes.privateDir, "marker"))).toBe(false);
      }
    );
  });
});

describe("worker probe", () => {
  const jobName = "workspace-proof-tick-r111-1";
  const schedulerCall = (command: string, format = "none") =>
    `gcloud scheduler jobs ${command} ${jobName} --project=${projectId} --location=europe-west1 --format=${format}`;
  const isSchedulerReceipt = (call: string) =>
    call.startsWith("gcloud logging read ") &&
    call.includes('jsonPayload.event="probe.schedule"');
  const pausedJob = {
    name: `projects/${projectId}/locations/europe-west1/jobs/${jobName}`,
    state: "PAUSED",
    schedule: "0 0 1 1 *",
    timeZone: "Etc/UTC",
    userUpdateTime: "2026-11-26T11:30:00.123Z",
    httpTarget: {
      uri: `${schedulerWorkerUrl}/api/cron/workspace/proof-tick`,
      httpMethod: "GET",
      oidcToken: {
        serviceAccountEmail: serviceAccount("workspace-scheduler-invoker"),
        audience: schedulerWorkerUrl,
      },
    },
  };
  const proofQueue = (path: string): FakeRule => ({
    tool: "gcloud",
    pattern: "^tasks queues describe workspace-paid-fulfillment-r111-1 ",
    stdout: JSON.stringify({
      state: "RUNNING",
      httpTarget: {
        httpMethod: "POST",
        uriOverride: {
          scheme: "HTTPS",
          host: tasksWorkerUrl.replace("https://", ""),
          pathOverride: { path },
          uriOverrideEnforceMode: "ALWAYS",
        },
        oidcToken: {
          serviceAccountEmail: serviceAccount("workspace-tasks-invoker"),
          audience: tasksWorkerUrl,
        },
      },
    }),
  });
  const receipts = (sha: string): ReadonlyArray<FakeRule> => [
    proofQueue("/api/queues/workspace/paid-fulfillment"),
    {
      tool: "gcloud",
      pattern: `^logging read .*service_name="workspace-tasks-worker" AND jsonPayload\\.event="probe\\.task" AND jsonPayload\\.queue="paid-fulfillment" AND jsonPayload\\.markerSha256="${sha}"`,
      stdout: JSON.stringify([
        { jsonPayload: { event: "probe.task", markerSha256: sha } },
      ]),
    },
  ];
  const workers = (
    rules: (sha: string, marker: string) => ReadonlyArray<FakeRule>,
    world: FakeWorld = {}
  ) =>
    withProofFakes(
      {
        now: Date.parse("2026-11-26T12:00:00Z") / 1000,
        schedulerJob: pausedJob,
        ...world,
      },
      (fakes) => {
        seedServices(fakes);
        seed(fakes, { "proof-run.env": "QUEUE_SUFFIX=r111-1\n" });
        const { marker, sha } = seedMarker(fakes);
        writeFileSync(
          fakes.env.FAKE_WORLD ?? "",
          JSON.stringify({ ...fakes.world(), rules: rules(sha, marker) })
        );
        return {
          ...runPhase(fakes, "worker-probe"),
          marker,
          calls: fakes.calls(),
          schedulerState: fakes.world().schedulerJob?.state,
          bodyLeft: existsSync(join(fakes.privateDir, "task-body.json")),
        };
      }
    );

  test("enqueues the marker in a task body and finds both receipts", () => {
    const result = workers(receipts);
    expect({
      exitCode: result.exitCode,
      output: result.exitCode === 0 ? "" : result.output,
    }).toEqual({ exitCode: 0, output: "" });
    expect(result.calls).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^gcloud tasks create-http-task --queue=workspace-paid-fulfillment-r111-1 --project=${projectId} --location=europe-west1 --url=${tasksWorkerUrl}/api/queues/workspace/paid-fulfillment --method=POST --header=Content-Type:application/json --body-file=\\S+ --format=value\\(name\\)$`
        )
      )
    );
    expect(
      result.calls.filter(
        (call) =>
          call.startsWith("gcloud scheduler jobs ") || isSchedulerReceipt(call)
      )
    ).toEqual([
      schedulerCall("describe", "json"),
      schedulerCall("resume"),
      schedulerCall("run"),
      expect.stringContaining('jsonPayload.event="probe.schedule"'),
      schedulerCall("pause"),
    ]);
    expect(result.schedulerState).toBe("PAUSED");
    expect(result.calls.filter((call) => call.includes(result.marker))).toEqual(
      []
    );
    expect(result.bodyLeft).toBe(false);
    expect(markerLeaks(result.output, result.marker)).toEqual([]);
  });

  test("refuses a marker other than the one the RPC probe sent", () => {
    withProofFakes({}, (fakes) => {
      seedServices(fakes);
      seed(fakes, { "proof-run.env": "QUEUE_SUFFIX=r111-1\n" });
      seedMarker(fakes, "0".repeat(64));
      const { exitCode, output } = runPhase(fakes, "worker-probe");
      expect(exitCode).toBe(1);
      expect(output).toContain("not the one the rpc-probe phase sent");
      expect(fakes.calls().join("\n")).not.toContain("tasks create-http-task");
    });
  });

  test("enqueues only through a queue bound to the paid-fulfillment route", () => {
    const { exitCode, output, calls } = workers((sha) => [
      proofQueue("/api/queues/workspace/reservation-expiry"),
      ...receipts(sha),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "does not send every task to /api/queues/workspace/paid-fulfillment on the tasks worker"
    );
    expect(calls.join("\n")).not.toContain("tasks create-http-task");
  });

  test("forces only the run's paused job aimed at the scheduler worker", () => {
    const overridesList: ReadonlyArray<Schema.JsonObject> = [
      { state: "ENABLED" },
      {
        httpTarget: {
          uri: `${apiUrl}/api/cron/workspace/proof-tick`,
          httpMethod: "GET",
        },
      },
    ];
    for (const overrides of overridesList) {
      const { exitCode, output, calls } = workers(receipts, {
        schedulerJob: { ...pausedJob, ...overrides },
      });
      expect({ overrides, exitCode }).toEqual({ overrides, exitCode: 1 });
      expect(output).toContain(
        "is not a paused GET of /api/cron/workspace/proof-tick"
      );
      expect(calls).not.toContain(schedulerCall("resume"));
      expect(calls).not.toContain(schedulerCall("run"));
    }
  });

  test("refuses to resume if a calendar tick could be mistaken for the manual run", () => {
    const unsafeJobs: ReadonlyArray<FakeWorld> = [
      { schedulerJob: { ...pausedJob, schedule: "* * * * *" } },
      { schedulerJob: { ...pausedJob, timeZone: "Europe/Prague" } },
      { schedulerJob: { ...pausedJob, userUpdateTime: null } },
      { schedulerJob: { ...pausedJob, userUpdateTime: "" } },
      {
        schedulerJob: { ...pausedJob, userUpdateTime: "2025-12-31T23:59:59Z" },
      },
      {
        schedulerJob: { ...pausedJob, userUpdateTime: "2026-11-26T12:01:00Z" },
      },
      { now: Date.parse("2026-12-31T23:50:00Z") / 1000 },
    ];
    for (const world of unsafeJobs) {
      const { exitCode, output, calls, schedulerState } = workers(
        receipts,
        world
      );
      expect({ world, exitCode }).toEqual({ world, exitCode: 1 });
      expect(output).toContain("cannot rule out a scheduled proof tick");
      expect(calls).not.toContain(schedulerCall("resume"));
      expect(calls).not.toContain(schedulerCall("run"));
      expect(schedulerState).toBe("PAUSED");
    }
  });

  test("re-pauses when the scheduler rejects the manual run", () => {
    const { exitCode, output, calls, schedulerState } = workers((sha) => [
      { tool: "gcloud", pattern: `^scheduler jobs run ${jobName} `, exit: 1 },
      ...receipts(sha),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("the proof-tick job could not be forced");
    expect(calls).toContain(schedulerCall("pause"));
    expect(calls.some(isSchedulerReceipt)).toBe(false);
    expect(schedulerState).toBe("PAUSED");
  });

  test("re-pauses when the manual run yields no worker receipt", () => {
    const { exitCode, output, calls, schedulerState } = workers((sha) => [
      {
        tool: "gcloud",
        pattern: '^logging read .*jsonPayload\\.event="probe\\.schedule"',
        stdout: "[]",
      },
      ...receipts(sha),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("no scheduler worker receipt within four minutes");
    expect(calls.at(-1)).toBe(schedulerCall("pause"));
    expect(schedulerState).toBe("PAUSED");
  });

  test("re-pauses after a resume error that leaves the job enabled", () => {
    const { exitCode, output, calls, schedulerState } = workers((sha) => [
      {
        tool: "gcloud",
        pattern: `^scheduler jobs resume ${jobName} `,
        set: { schedulerJob: { ...pausedJob, state: "ENABLED" } },
        exit: 1,
      },
      ...receipts(sha),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("the proof-tick job could not be resumed");
    expect(calls).not.toContain(schedulerCall("run"));
    expect(calls.at(-1)).toBe(schedulerCall("pause"));
    expect(schedulerState).toBe("PAUSED");
  });

  test.each([
    ["PAUSED", 0],
    ["ENABLED", 0],
    ["PAUSED", 1],
  ] as const)(
    "requires paused readback after a pause error leaves %s (describe exit %i)",
    (state, describeExit) => {
      const { exitCode, output, calls, schedulerState } = workers((sha) => [
        {
          tool: "gcloud",
          pattern: `^scheduler jobs pause ${jobName} `,
          set: { schedulerJob: { ...pausedJob, state } },
          exit: 1,
        },
        {
          tool: "gcloud",
          pattern: `^scheduler jobs describe ${jobName} .* --format=value\\(state\\)$`,
          stdout: state,
          exit: describeExit,
        },
        ...receipts(sha),
      ]);
      const confirmedPaused = state === "PAUSED" && describeExit === 0;
      expect(exitCode).toBe(confirmedPaused ? 0 : 1);
      if (!confirmedPaused) {
        expect(output).toContain("the proof-tick job could not be re-paused");
      }
      expect(calls.at(-1)).toBe(schedulerCall("describe", "value(state)"));
      expect(schedulerState).toBe(state);
    }
  );

  test("fails when a receipt carries the raw marker", () => {
    const { exitCode, output, marker } = workers((sha, leaked) => [
      {
        tool: "gcloud",
        pattern: '^logging read .*"probe\\.task"',
        stdout: JSON.stringify([
          { jsonPayload: { markerSha256: sha, body: leaked } },
        ]),
      },
      ...receipts(sha),
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain("tasks worker receipt carries the raw marker");
    expect(markerLeaks(output, marker)).toEqual([]);
  });

  test("fails without a receipt or a readable log", () => {
    const missing = workers((sha) => [
      {
        tool: "gcloud",
        pattern: '^logging read .*"probe\\.schedule"',
        stdout: "[]",
      },
      ...receipts(sha),
    ]);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain("no scheduler worker receipt");
    const denied = workers(() => [
      proofQueue("/api/queues/workspace/paid-fulfillment"),
      { tool: "gcloud", pattern: "^logging read ", exit: 1 },
    ]);
    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain(
      "Cloud Logging is unreadable; tasks worker receipt is unverified"
    );
  });
});

describe("telemetry privacy", () => {
  const requestLog: FakeRule = {
    tool: "gcloud",
    pattern: `^logging read .*log_id\\("run\\.googleapis\\.com/requests"\\) AND httpRequest\\.requestMethod="POST" AND trace="projects/${projectId}/traces/${traceId}"`,
    stdout: JSON.stringify([
      {
        trace: `projects/${projectId}/traces/${traceId}`,
        httpRequest: { requestUrl: `${apiUrl}/rpc` },
      },
    ]),
  };
  const markerLogReadPattern =
    '^logging read "sandbox-marker-[0-9a-f]+" --project=';
  const baseRules: ReadonlyArray<FakeRule> = [
    requestLog,
    { tool: "gcloud", pattern: markerLogReadPattern, stdout: "[]" },
    {
      tool: "curl",
      pattern: `cloudtrace\\.googleapis\\.com/v1/projects/${projectId}/traces/${traceId}$`,
      stdout: JSON.stringify({ traceId, spans: [{ name: "/rpc" }] }),
    },
    {
      tool: "curl",
      pattern: "cloudtrace\\.googleapis\\.com/v1/projects/.*/traces\\?",
      stdout: JSON.stringify({ traces: [{ traceId }] }),
    },
  ];
  const privacy = (
    overrides: (marker: string) => ReadonlyArray<FakeRule> = () => []
  ) =>
    withProofFakes({}, (fakes) => {
      seed(fakes, { "telemetry.env": `PROBE_TRACE_ID=${traceId}\n` });
      const { marker } = seedMarker(fakes);
      writeFileSync(
        fakes.env.FAKE_WORLD ?? "",
        JSON.stringify({ rules: [...overrides(marker), ...baseRules] })
      );
      return {
        ...runPhase(fakes, "telemetry-privacy"),
        marker,
        calls: fakes.calls(),
      };
    });

  test("passes once both controls are found and the marker is nowhere", () => {
    for (const requestUrl of [`${apiUrl}/rpc`, `${apiUrl}/rpc/`]) {
      const { exitCode, output, marker, calls } = privacy(() => [
        {
          ...requestLog,
          stdout: JSON.stringify([
            {
              trace: `projects/${projectId}/traces/${traceId}`,
              httpRequest: { requestUrl },
            },
          ]),
        },
      ]);
      expect({
        requestUrl,
        exitCode,
        output: exitCode === 0 ? "" : output,
      }).toEqual({
        requestUrl,
        exitCode: 0,
        output: "",
      });
      expect(calls).toContain(
        `gcloud logging read "${marker}" --project=${projectId} --freshness=7200s --limit=20 --format=json(logName,timestamp)`
      );
      expect(
        calls.some(
          (call) =>
            call.includes("jsonPayload:") ||
            call.includes("textPayload:") ||
            call.includes("httpRequest.requestUrl:")
        )
      ).toBe(false);
      expect(markerLeaks(output, marker)).toEqual([]);
    }
  });

  test("fails closed when the trace control is absent or unreadable", () => {
    for (const rule of [
      { tool: "curl", pattern: `traces/${traceId}$`, stdout: "{}" },
      { tool: "curl", pattern: `traces/${traceId}$`, exit: 22 },
    ]) {
      const { exitCode, output } = privacy(() => [rule]);
      expect({ rule, exitCode }).toEqual({ rule, exitCode: 1 });
      expect(output).toContain("trace control unavailable");
    }
  });

  test("fails without the probe's POST /rpc request log", () => {
    for (const stdout of [
      "[]",
      JSON.stringify([
        {
          trace: `projects/${projectId}/traces/${traceId}`,
          httpRequest: { requestUrl: `${apiUrl}/healthz` },
        },
      ]),
      JSON.stringify([
        {
          trace: `projects/${projectId}/traces/${traceId}`,
          httpRequest: { requestUrl: `${apiUrl}/rpc/extra` },
        },
      ]),
      JSON.stringify([
        {
          trace: `projects/${projectId}/traces/${traceId}`,
          httpRequest: { requestUrl: `${apiUrl}/rpc//` },
        },
      ]),
      JSON.stringify([
        {
          trace: `projects/${projectId}/traces/${traceId}`,
          httpRequest: { requestUrl: `${apiUrl}/rpc2` },
        },
      ]),
    ]) {
      const { exitCode, output } = privacy(() => [{ ...requestLog, stdout }]);
      expect({ stdout, exitCode }).toEqual({ stdout, exitCode: 1 });
      expect(output).toContain(
        "no POST /rpc request log carries the probe trace"
      );
    }
    const denied = privacy(() => [{ ...requestLog, exit: 1 }]);
    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain("Cloud Run request logs are unreadable");
  });

  test("fails when the marker reached a log entry or a span", () => {
    const logged = privacy(() => [
      {
        tool: "gcloud",
        pattern: markerLogReadPattern,
        stdout: JSON.stringify([{ logName: "projects/x/logs/stdout" }]),
      },
    ]);
    expect(logged.exitCode).toBe(1);
    expect(logged.output).toContain("the marker reached readable logs");
    expect(markerLeaks(logged.output, logged.marker)).toEqual([]);
    const spanned = privacy((marker) => [
      {
        tool: "curl",
        pattern: "/traces\\?",
        stdout: JSON.stringify({
          traces: [
            { traceId, spans: [{ name: "/rpc", labels: { body: marker } }] },
          ],
        }),
      },
    ]);
    expect(spanned.exitCode).toBe(1);
    expect(spanned.output).toContain("the marker reached a Cloud Trace span");
    expect(markerLeaks(spanned.output, spanned.marker)).toEqual([]);
  });

  test("fails when a log read or the trace listing is unusable", () => {
    const denied = privacy(() => [
      {
        tool: "gcloud",
        pattern: markerLogReadPattern,
        exit: 1,
        stderr:
          "ERROR: (gcloud.logging.read) INVALID_ARGUMENT: Cannot match a nested type 'jsonPayload'.",
      },
    ]);
    expect(denied.exitCode).toBe(1);
    expect(denied.output).toContain("marker absence in logs unverified");
    expect(markerLeaks(denied.output, denied.marker)).toEqual([]);
    const malformed = privacy(() => [
      {
        tool: "gcloud",
        pattern: markerLogReadPattern,
        stdout: "{}",
      },
    ]);
    expect(malformed.exitCode).toBe(1);
    expect(malformed.output).toContain("the marker reached readable logs");
    const omitted = privacy(() => [
      {
        tool: "curl",
        pattern: "/traces\\?",
        stdout: JSON.stringify({ traces: [{ traceId: "f".repeat(32) }] }),
      },
    ]);
    expect(omitted.exitCode).toBe(1);
    expect(omitted.output).toContain(
      "the trace listing omits the probe's trace"
    );
  });

  test("scans traces from the primary probe when it ran over an hour ago", () => {
    const now = 1_800_000_000;
    const calls = withProofFakes({ now, rules: baseRules }, (fakes) => {
      seed(fakes, {
        "telemetry.env": `PROBE_TRACE_ID=${traceId}\nPROBE_STARTED_AT=${now - 7200}\n`,
      });
      seedMarker(fakes);
      expect(runPhase(fakes, "telemetry-privacy").exitCode).toBe(0);
      return fakes.calls();
    });
    // The 90 s ingestion wait moved the fake clock; the window does not.
    const start = new Date((now - 7200 - 300) * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    expect(calls).toContainEqual(
      expect.stringContaining(
        `/traces?view=COMPLETE&pageSize=100&startTime=${start}`
      )
    );
  });

  test("reads every trace page with its page token URL-encoded", () => {
    const { exitCode, output } = privacy(() => [
      {
        tool: "curl",
        pattern:
          "/traces\\?view=COMPLETE&pageSize=100&startTime=[^&]+&pageToken=a%2Bb%2Fc%3D$",
        stdout: JSON.stringify({ traces: [{ traceId }] }),
      },
      { tool: "curl", pattern: "/traces\\?.*&pageToken=", exit: 22 },
      {
        tool: "curl",
        pattern: "/traces\\?view=COMPLETE&pageSize=100&startTime=[^&]+$",
        stdout: JSON.stringify({
          traces: [{ traceId: "f".repeat(32) }],
          nextPageToken: "a+b/c=",
        }),
      },
    ]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  });
});

describe("baseline inventory", () => {
  const baseline = (rules: ReadonlyArray<FakeRule>) =>
    withProofFakes({ rules: [...rules, ...readableLogging] }, (fakes) =>
      runPhase(fakes, "baseline-inventory")
    );

  test("passes when no edge or log exclusion resource exists", () => {
    const { exitCode, output } = baseline([]);
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  });

  describe("fails on any edge resource, any exclusion or an unreadable class", () => {
    for (const [rule, message] of [
      [
        computeList("networkEndpointGroups", {
          items: {
            "zones/europe-west1-b": {
              networkEndpointGroups: [{ name: "legacy-neg" }],
            },
          },
        }),
        "the project already holds network-endpoint-groups: legacy-neg",
      ],
      [
        {
          tool: "curl",
          pattern: "logging\\.googleapis\\.com/v2/projects/.*/exclusions",
          stdout: JSON.stringify({ exclusions: [{ name: "drop-noise" }] }),
        },
        "the project already holds logging-exclusions: drop-noise",
      ],
      [
        sinksPage(`projects/${projectId}`, [
          {
            name: "export",
            destination: "bigquery.googleapis.com/x",
            exclusions: [{ name: "drop-noise" }],
          },
        ]),
        "the project already holds sink-exclusions: export\tdrop-noise",
      ],
      [
        { ...computeList("sslCertificates", {}), stdout: undefined, exit: 22 },
        "ssl-certificates is unreadable",
      ],
      [
        computeList("urlMaps", {
          items: {},
          unreachables: ["regions/us-east1"],
        }),
        "url-maps is unreadable",
      ],
      [
        computeList("targetHttpsProxies", {
          items: {
            "regions/europe-west1": { warning: { code: "UNREACHABLE" } },
          },
        }),
        "target-https-proxies is unreadable",
      ],
    ] as const) {
      test(message, () => {
        const { exitCode, output } = baseline([rule]);
        expect(exitCode).toBe(1);
        expect(output).toContain(message);
      });
    }
  });
});
