import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Schema from "effect/Schema";
import {
  configuredWorkspaceStack,
  decodeWorkspaceStackConfig,
  GcpRegion,
  serializeWorkspaceStackConfig,
  type WorkspaceStackConfig,
  WorkspaceStackConfigInvalid,
} from "./stack-config";
import { sandboxConfig, sandboxConfigInput } from "./stack-config.test-utils";

const rejection = <E>(decoding: Effect.Effect<WorkspaceStackConfig, E>) => {
  const exit = Effect.runSyncExit(decoding);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected the configuration to be rejected");
  }
  const error = exit.cause.reasons
    .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
    .find((candidate) => candidate instanceof WorkspaceStackConfigInvalid);
  if (error === undefined) {
    throw new Error("expected a WorkspaceStackConfigInvalid failure");
  }
  return error;
};

const decodeFailure = (input: Schema.Json) =>
  rejection(decodeWorkspaceStackConfig(input));

const configuredFailure = (raw: string) =>
  rejection(
    configuredWorkspaceStack.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ WORKSPACE_STACK_CONFIG: raw })
        )
      )
    )
  );

const fakePrivateKey =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

describe("workspace stack configuration", () => {
  test("defaults the region to europe-west1", () => {
    expect(sandboxConfig.region).toBe(GcpRegion.make("europe-west1"));
    expect(sandboxConfig.stage).toBe("sandbox");
  });

  test("requires approved spend and teardown on a sandbox", () => {
    const { budget: _budget, ...withoutBudget } = sandboxConfigInput;
    expect(decodeFailure(withoutBudget).paths).toContain("budget");
  });

  test("names an overflowing budget in the stage config by its field path", () => {
    const raw = JSON.stringify(sandboxConfigInput).replace(
      /"maximumSpend":[^,}]+/,
      '"maximumSpend":1e400'
    );
    expect(configuredFailure(raw).paths).toEqual(["budget.maximumSpend"]);
  });

  test("reports secret material in the stage config even beside an overflowing budget", () => {
    const raw = JSON.stringify({
      ...sandboxConfigInput,
      secrets: [{ ...sandboxConfigInput.secrets[0], value: "plain-text" }],
    }).replace(/"maximumSpend":[^,}]+/, '"maximumSpend":1e400');
    const failure = configuredFailure(raw);
    expect(failure.reason).toBe("secret-material");
    expect(failure.paths).toEqual(["secrets.0.value"]);
  });

  test("rejects a secret value placed beside a reference", () => {
    const error = decodeFailure({
      ...sandboxConfigInput,
      secrets: [
        { ...sandboxConfigInput.secrets[0], value: "postgres-password-1" },
      ],
    });
    expect(error.reason).toBe("secret-material");
    expect(error.paths).toEqual(["secrets.0.value"]);
    expect(error.message).not.toContain("postgres-password-1");
  });

  test("rejects secret material under an allowed key without echoing it", () => {
    const leaked = "postgresql://workspace:s3cr3t-pass@db.internal/workspace";
    for (const [input, path] of [
      [{ ...sandboxConfigInput, stateBucket: leaked }, "stateBucket"],
      [
        {
          ...sandboxConfigInput,
          secrets: [
            { ...sandboxConfigInput.secrets[0], secretId: fakePrivateKey },
          ],
        },
        "secrets.0.secretId",
      ],
    ] as const) {
      const error = decodeFailure(input);
      expect(error.paths).toEqual([path]);
      expect(error.message).not.toContain("s3cr3t-pass");
      expect(error.message).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(error)).not.toContain("s3cr3t-pass");
    }
  });

  test("rejects unknown keys and unpinned secret versions by path only", () => {
    const error = decodeFailure({
      ...sandboxConfigInput,
      extra: "unexpected",
      secrets: [{ ...sandboxConfigInput.secrets[0], version: "latest" }],
    });
    expect(error.reason).toBe("schema");
    expect(error.paths).toEqual(
      expect.arrayContaining(["extra", "secrets.0.version"])
    );
    expect(error.message).not.toContain("unexpected");
  });

  test("rejects a service account outside the naming rules", () => {
    expect(
      decodeFailure({
        ...sandboxConfigInput,
        serviceAccounts: {
          ...sandboxConfigInput.serviceAccounts,
          deployer: testEmailAddress("someone"),
        },
      }).paths
    ).toEqual(["serviceAccounts.deployer"]);
  });

  test("requires the project's own state bucket, which holds its one release lock", () => {
    expect(
      decodeFailure({
        ...sandboxConfigInput,
        stateBucket: "deskohub-ws-sandbox-other-state",
      })
    ).toMatchObject({ reason: "identity", paths: ["stateBucket"] });
  });

  test("requires a distinct service account per role in the stage's project", () => {
    const foreign = decodeFailure({
      ...sandboxConfigInput,
      serviceAccounts: {
        ...sandboxConfigInput.serviceAccounts,
        // A service account identifier in another project, not a mailbox.
        apiRuntime: [
          "workspace-api",
          "deskohub-ws-production.iam.gserviceaccount.com",
        ].join("@"),
      },
    });
    expect(foreign).toMatchObject({
      reason: "identity",
      paths: ["serviceAccounts.apiRuntime"],
    });
    const shared = decodeFailure({
      ...sandboxConfigInput,
      serviceAccounts: {
        ...sandboxConfigInput.serviceAccounts,
        tasksInvoker: sandboxConfigInput.serviceAccounts.schedulerInvoker,
      },
    });
    expect(shared.paths.toSorted()).toEqual([
      "serviceAccounts.schedulerInvoker",
      "serviceAccounts.tasksInvoker",
    ]);
  });

  test("serializes identifiers and pinned versions only", () => {
    const serialized = serializeWorkspaceStackConfig(sandboxConfig);
    expect(JSON.parse(serialized)).toMatchObject({
      region: "europe-west1",
      secrets: [
        {
          environmentVariable: "DATABASE_URL",
          secretId: "workspace-database-url",
          version: "3",
        },
      ],
    });
    expect(
      Effect.runSync(decodeWorkspaceStackConfig(JSON.parse(serialized)))
    ).toEqual(sandboxConfig);
  });

  test("rejects the retired edge and collector sidecar keys", () => {
    const error = decodeFailure({
      ...sandboxConfigInput,
      edge: { domains: [], enableHttps: false },
      telemetryCollectorImage: `sha256:${"a".repeat(64)}`,
    });
    expect(error.reason).toBe("schema");
    expect(error.paths).toEqual(
      expect.arrayContaining(["edge", "telemetryCollectorImage"])
    );
  });
});
