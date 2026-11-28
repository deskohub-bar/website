import { describe, expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  decodeWorkspaceStackConfig,
  type WorkspaceStackConfig,
} from "../config/stack-config";
import {
  sandboxConfig,
  sandboxConfigInput,
} from "../config/stack-config.test-utils";
import { queueProps } from "../resources/queue-declarations";
import { scheduleJobProps } from "../resources/schedule-declarations";
import { cloudTasksLimits, workspaceQueueContracts } from "./queue-contracts";
import {
  workspaceScheduleContracts,
  workspaceScheduleTimeZone,
} from "./schedule-contracts";

/** The Vercel declaration this stack replaces, read without changing it. */
const vercel: {
  readonly crons: ReadonlyArray<{ path: string; schedule: string }>;
  readonly functions: Record<
    string,
    { experimentalTriggers?: ReadonlyArray<{ topic: string }> }
  >;
} = await Bun.file(
  new URL("../../../../apps/deskohub-workspace/vercel.json", import.meta.url)
).json();

const vercelQueues = Object.entries(vercel.functions).flatMap(
  ([file, config]) =>
    (config.experimentalTriggers ?? []).map((trigger) => ({
      topic: trigger.topic,
      handlerPath: `/${file.replace(/^app\//, "").replace(/\/route\.ts$/, "")}`,
    }))
);

const hours = (contractTopic: string) => {
  const contract = workspaceQueueContracts.find(
    (entry) => entry.topic === contractTopic
  );
  return contract?.transportLifetime.kind === "bounded"
    ? Duration.toHours(contract.transportLifetime.maxRetryDuration)
    : contract?.transportLifetime.kind;
};

describe("queue contracts", () => {
  test("cover exactly the six Vercel queue topics and their handlers", () => {
    expect(vercelQueues).toHaveLength(6);
    expect(
      workspaceQueueContracts
        .map(({ topic, handlerPath }) => ({ topic, handlerPath }))
        .toSorted((a, b) => a.topic.localeCompare(b.topic))
    ).toEqual(vercelQueues.toSorted((a, b) => a.topic.localeCompare(b.topic)));
  });

  test("keep the #1456 transport lifetimes", () => {
    expect({
      campaignSend: hours("workspace-email-campaign-send"),
      automationUnit: hours("workspace-email-automation-unit"),
      fioPoll: hours("workspace-fio-account-poll"),
      latePayment: hours("workspace-late-payment-recovery"),
      paidFulfillment: hours("workspace-paid-fulfillment"),
      holdCleanup: hours("workspace-reservation-hold-cleanup"),
    }).toEqual({
      campaignSend: 48,
      automationUnit: "provider-default",
      fioPoll: 24,
      latePayment: 168,
      paidFulfillment: 24,
      holdCleanup: 1,
    });
  });

  test("stay inside the Cloud Tasks horizon, retention and attempt deadline", () => {
    for (const contract of workspaceQueueContracts) {
      expect(
        Duration.isLessThanOrEqualTo(
          contract.maxScheduleDelay,
          cloudTasksLimits.scheduleHorizon
        )
      ).toBe(true);
      expect(
        Duration.isLessThanOrEqualTo(
          contract.dispatchDeadline,
          cloudTasksLimits.httpAttemptDeadline
        )
      ).toBe(true);
      if (contract.transportLifetime.kind === "bounded") {
        expect(
          Duration.isLessThanOrEqualTo(
            Duration.sum(
              contract.maxScheduleDelay,
              contract.transportLifetime.maxRetryDuration
            ),
            cloudTasksLimits.taskRetention
          )
        ).toBe(true);
      }
    }
    const holdCleanup = workspaceQueueContracts.find(
      (entry) => entry.topic === "workspace-reservation-hold-cleanup"
    );
    expect(holdCleanup && Duration.toDays(holdCleanup.maxScheduleDelay)).toBe(
      7
    );
    // Cloud Tasks counts retries from the first attempt, so the publisher's
    // 7-day clamp from enqueue is an application expiry.
    expect(
      holdCleanup?.absoluteExpiry && Duration.toDays(holdCleanup.absoluteExpiry)
    ).toBe(7);
    // Topics whose Cloud Tasks delivery is not yet safe say what must hold.
    expect(
      workspaceQueueContracts
        .filter((contract) => contract.activationGate !== undefined)
        .map((contract) => contract.topic)
    ).toEqual([
      "workspace-email-automation-unit",
      "workspace-reservation-hold-cleanup",
    ]);
  });

  test("give each sandbox run's queues the run's disposable suffix", () => {
    const queueIds = (config: WorkspaceStackConfig) =>
      workspaceQueueContracts.map(
        (contract) => queueProps(config, contract).queueId
      );
    const contractIds = workspaceQueueContracts.map(
      (contract) => contract.queueId
    );
    expect(queueIds(sandboxConfig)).toEqual(contractIds);
    expect(
      queueIds(
        Effect.runSync(
          decodeWorkspaceStackConfig({
            ...sandboxConfigInput,
            disposableQueueSuffix: "r111-2",
          })
        )
      )
    ).toEqual(contractIds.map((queueId) => `${queueId}-r111-2`));
  });

  test("declare queues with the shared retry policy and a pinned private target", () => {
    const props = workspaceQueueContracts.map((contract) =>
      queueProps(sandboxConfig, contract)
    );
    expect(props.map((queue) => queue.retryConfig)).toEqual([
      {
        maxAttempts: -1,
        maxRetryDuration: "172800s",
        minBackoff: "60s",
        maxBackoff: "900s",
        maxDoublings: 4,
      },
      {
        maxAttempts: -1,
        minBackoff: "60s",
        maxBackoff: "900s",
        maxDoublings: 4,
      },
      {
        maxAttempts: -1,
        maxRetryDuration: "86400s",
        minBackoff: "60s",
        maxBackoff: "900s",
        maxDoublings: 4,
      },
      {
        maxAttempts: -1,
        maxRetryDuration: "604800s",
        minBackoff: "60s",
        maxBackoff: "900s",
        maxDoublings: 4,
      },
      {
        maxAttempts: -1,
        maxRetryDuration: "86400s",
        minBackoff: "60s",
        maxBackoff: "900s",
        maxDoublings: 4,
      },
      {
        maxAttempts: -1,
        maxRetryDuration: "3600s",
        minBackoff: "60s",
        maxBackoff: "900s",
        maxDoublings: 4,
      },
    ]);
    for (const [index, queue] of props.entries()) {
      expect(queue.location).toBe("europe-west1");
      expect(queue.httpTarget).toEqual({
        httpMethod: "POST",
        uriOverride: {
          scheme: "HTTPS",
          host: "workspace-tasks-worker-123456789012.europe-west1.run.app",
          port: "443",
          queryOverride: { queryParams: "" },
          pathOverride: {
            path: workspaceQueueContracts[index]?.handlerPath,
          },
          uriOverrideEnforceMode: "ALWAYS",
        },
        oidcToken: {
          serviceAccountEmail: sandboxConfig.serviceAccounts.tasksInvoker,
          audience:
            "https://workspace-tasks-worker-123456789012.europe-west1.run.app",
        },
      });
    }
  });
});

describe("schedule contracts", () => {
  test("match the ten Vercel crons and their UTC schedules exactly", () => {
    expect(vercel.crons).toHaveLength(10);
    expect(
      workspaceScheduleContracts.map(({ handlerPath, schedule }) => ({
        path: handlerPath,
        schedule,
      }))
    ).toEqual([...vercel.crons]);
  });

  test("declare OIDC jobs against the private scheduler worker", () => {
    for (const contract of workspaceScheduleContracts) {
      const job = scheduleJobProps(sandboxConfig, contract);
      expect(job).toMatchObject({
        schedule: contract.schedule,
        timeZone: workspaceScheduleTimeZone,
        paused: false,
        retryConfig: { retryCount: 0 },
        httpTarget: {
          uri: `https://workspace-scheduler-worker-123456789012.europe-west1.run.app${contract.handlerPath}`,
          httpMethod: "GET",
          oidcToken: {
            serviceAccountEmail: sandboxConfig.serviceAccounts.schedulerInvoker,
            audience:
              "https://workspace-scheduler-worker-123456789012.europe-west1.run.app",
          },
        },
      });
    }
  });

  test("keep the route budgets as attempt deadlines", () => {
    expect(
      Object.fromEntries(
        workspaceScheduleContracts.map((contract) => [
          contract.jobId,
          scheduleJobProps(sandboxConfig, contract).attemptDeadline,
        ])
      )
    ).toMatchObject({
      "workspace-reservation-invitees": "60s",
      "workspace-reservation-invitee-notices": "60s",
      "workspace-payment-refunds": "300s",
      "workspace-pass-purchases": "300s",
    });
  });
});
