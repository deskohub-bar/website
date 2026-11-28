import "@/shared/testing/workspace-test-env";

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import * as vercelQueue from "@vercel/queue";
import { Data, Effect, Schema } from "effect";
import {
  googleInvokerSettings,
  mockWorkerHost,
  schedulerInvoker,
  serveGoogleSigningKeys,
  tasksInvoker,
} from "@/shared/testing/google-oidc.test-utils";
import { captureWorkspaceLogs } from "@/shared/testing/workspace-telemetry.test-utils";
import type {
  QueueConsumer,
  QueueDelivery,
  QueueDeliveryMode,
  QueueDeliveryOutcome,
} from "./queue-consumer";
import type { WorkspaceQueueTopic } from "./workspace-queue-topics";

const workspaceLogs = captureWorkspaceLogs();
const nextServer = await import("next/server");
// Outside a Next request, scheduling the telemetry flush would log a warning.
mock.module("next/server", () => ({ ...nextServer, after: () => undefined }));

// The Vercel transport answers a marker, so a test sees which one ran.
const handleCallback = mock(
  () => () => Promise.resolve(new Response("vercel", { status: 299 }))
);
mock.module("@vercel/queue", () => ({ ...vercelQueue, handleCallback }));

const containerHost = {
  WORKSPACE_RUNTIME_HOST: "container",
  VERCEL_ENV: "production",
  ...googleInvokerSettings,
} as const;
const setHost = await mockWorkerHost(containerHost);

const { QueueRedelivery } = await import("./queue-consumer");
const { defineQueueTopic } = await import("./queue-topic");
const { defineQueueRoute } = await import("./queue-route");

const google = await serveGoogleSigningKeys();
afterAll(() => google.restore());
afterEach(() => {
  setHost(containerHost);
});

// Any registered topic; the adapter only carries it into the delivery.
const topic: WorkspaceQueueTopic = "workspace-paid-fulfillment";

const taskRequest = (
  authorization: string | undefined,
  body: BodyInit = JSON.stringify({ parcelId: "p-1" }),
  headers: Record<string, string> = {}
) => {
  const request = new Request(
    `https://tasks-worker.workspace.test/api/queues/${topic}`,
    {
      method: "POST",
      body,
      duplex: "half",
      headers: {
        "content-type": "application/json",
        "x-cloudtasks-queuename": "workspace-test-parcel-queue",
        "x-cloudtasks-taskname": "task-1",
        "x-cloudtasks-taskretrycount": "0",
        "x-cloudtasks-taskexecutioncount": "0",
        "x-cloudtasks-tasketa": "1795000000.5",
        ...headers,
      },
    }
  );
  if (authorization !== undefined) {
    request.headers.set("authorization", authorization);
  }
  return request;
};

const recordingRoute = (
  outcome: QueueDeliveryOutcome = { _tag: "Handled" }
) => {
  const deliveries: {
    readonly delivery: QueueDelivery;
    readonly mode: QueueDeliveryMode;
  }[] = [];
  const consume: QueueConsumer<never> = (delivery, mode) =>
    Effect.sync(() => {
      deliveries.push({ delivery, mode });
      return outcome;
    });
  return { POST: defineQueueRoute("parcelQueue", topic, consume), deliveries };
};

const bearer = async (...args: Parameters<typeof google.token>) =>
  `Bearer ${await google.token(...args)}`;

describe("Cloud Tasks authentication", () => {
  test.each([
    // Cloud Tasks headers alone never authenticate a request.
    ["no authorization", undefined],
    ["a non-bearer scheme", "Basic dGFza3M6dGFza3M="],
    ["a malformed bearer token", "Bearer not-a-jwt"],
  ])("rejects %s with 401 before the handler", async (_, authorization) => {
    const { POST, deliveries } = recordingRoute();

    const response = await POST(taskRequest(authorization));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(deliveries).toHaveLength(0);
  });

  test.each([
    ["an expired token", { expiresIn: -120 }],
    ["a token issued in the future", { issuedAt: 600, expiresIn: 4000 }],
    ["a token for another audience", { aud: schedulerInvoker.audience }],
    [
      "a token for several audiences",
      { aud: [tasksInvoker.audience, schedulerInvoker.audience] },
    ],
    ["a token from another issuer", { iss: "https://issuer.test" }],
  ] as const)("rejects %s with 401", async (_, claims) => {
    const { POST, deliveries } = recordingRoute();

    const response = await POST(
      taskRequest(await bearer(tasksInvoker, claims))
    );

    expect(response.status).toBe(401);
    expect(deliveries).toHaveLength(0);
  });

  test("rejects a token whose signature Google's keys don't verify", async () => {
    const { POST, deliveries } = recordingRoute();

    const response = await POST(
      taskRequest(await bearer(tasksInvoker, {}, "foreign"))
    );

    expect(response.status).toBe(401);
    expect(deliveries).toHaveLength(0);
  });

  test("rejects the scheduler invoker's token for this audience with 403", async () => {
    const { POST, deliveries } = recordingRoute();

    const response = await POST(
      taskRequest(
        await bearer(schedulerInvoker, { aud: tasksInvoker.audience })
      )
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(deliveries).toHaveLength(0);
  });

  test("rejects an unverified invoker email with 401", async () => {
    const { POST, deliveries } = recordingRoute();

    const own = await POST(
      taskRequest(await bearer(tasksInvoker, { email_verified: false }))
    );
    const other = await POST(
      taskRequest(
        await bearer(schedulerInvoker, {
          aud: tasksInvoker.audience,
          email_verified: false,
        })
      )
    );

    expect([own.status, other.status]).toEqual([401, 401]);
    expect(deliveries).toHaveLength(0);
  });

  test("accepts any scheme casing and spaces before the token", async () => {
    const { POST, deliveries } = recordingRoute();
    const token = await google.token(tasksInvoker);
    const otherAccount = await google.token(schedulerInvoker, {
      aud: tasksInvoker.audience,
    });

    const lower = await POST(taskRequest(`bearer ${token}`));
    const spaced = await POST(taskRequest(`BEARER   ${token}`));
    const wrongAccount = await POST(taskRequest(`bearer  ${otherAccount}`));

    expect([lower.status, spaced.status, wrongAccount.status]).toEqual([
      200, 200, 403,
    ]);
    expect(deliveries).toHaveLength(2);
  });

  test("accepts Google's bare issuer", async () => {
    const { POST, deliveries } = recordingRoute();

    const response = await POST(
      taskRequest(await bearer(tasksInvoker, { iss: "accounts.google.com" }))
    );

    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(1);
  });

  test.each([
    ["the invoker email", "WORKSPACE_TASKS_INVOKER_EMAIL"],
    ["the audience", "WORKSPACE_TASKS_AUDIENCE"],
  ])("rejects every request without %s", async (_, setting) => {
    setHost({ ...containerHost, [setting]: undefined });
    const { POST, deliveries } = recordingRoute();

    const response = await POST(taskRequest(await bearer(tasksInvoker)));

    expect(response.status).toBe(401);
    expect(deliveries).toHaveLength(0);
  });

  test("never echoes the token", async () => {
    const authorization = await bearer(tasksInvoker, { expiresIn: -120 });
    const { POST } = recordingRoute();

    const response = await POST(taskRequest(authorization));

    expect(await response.text()).not.toContain(authorization.slice(7, 40));
  });
});

describe("Cloud Tasks delivery", () => {
  test("delivers the body with the task's metadata", async () => {
    const { POST, deliveries } = recordingRoute();

    const response = await POST(
      taskRequest(await bearer(tasksInvoker), undefined, {
        "x-cloudtasks-taskretrycount": "3",
        "x-cloudtasks-taskexecutioncount": "1",
      })
    );

    expect(response.status).toBe(200);
    expect(deliveries).toEqual([
      {
        delivery: {
          payload: { parcelId: "p-1" },
          topic,
          messageId: "task-1",
          deliveryCount: 4,
        },
        mode: "durable",
      },
    ]);
  });

  test("counts a delivery without a retry count as the first", async () => {
    const { POST, deliveries } = recordingRoute();

    await POST(
      taskRequest(await bearer(tasksInvoker), undefined, {
        "x-cloudtasks-taskretrycount": "many",
      })
    );

    expect(deliveries[0]?.delivery.deliveryCount).toBe(1);
  });

  test.each([
    ["preview", "preview"],
    ["production", "durable"],
    ["development", "durable"],
  ] as const)("a %s stage delivers in %s mode", async (stage, mode) => {
    setHost({ ...containerHost, VERCEL_ENV: stage });
    const { POST, deliveries } = recordingRoute();

    await POST(taskRequest(await bearer(tasksInvoker)));

    expect(deliveries[0]?.mode).toBe(mode);
  });

  test("retries a body that fails to arrive", async () => {
    const { POST, deliveries } = recordingRoute();

    const response = await POST(
      taskRequest(
        await bearer(tasksInvoker),
        new ReadableStream({
          pull: (controller) => controller.error(new Error("connection reset")),
        })
      )
    );

    expect(response.status).toBe(500);
    expect(deliveries).toHaveLength(0);
  });

  test("acknowledges a body that is not JSON without delivering it", async () => {
    workspaceLogs.reset();
    const { POST, deliveries } = recordingRoute();

    const response = await POST(
      taskRequest(await bearer(tasksInvoker), "{not json")
    );

    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(0);
    const ignored = workspaceLogs
      .records()
      .find(({ severityText }) => severityText === "warn");
    expect(ignored?.attributes).toMatchObject({
      cloudTasksQueue: "workspace-test-parcel-queue",
      cloudTasksEta: "1795000000.5",
    });
  });
});

class ParcelNotReadyError extends Data.TaggedError("ParcelNotReadyError") {}

const parcelTopic = defineQueueTopic({
  topic,
  label: "Parcel",
  message: Schema.toStandardSchemaV1(
    Schema.Struct({ parcelId: Schema.NonEmptyString })
  ),
  publish: (parcelId: string) => ({
    message: { parcelId },
    key: `parcel:${parcelId}`,
  }),
});

describe("Cloud Tasks responses", () => {
  const parcelRoute = (
    handle: () => Effect.Effect<unknown, ParcelNotReadyError>,
    redelivery = () => QueueRedelivery.WithBackoff()
  ) =>
    defineQueueRoute(
      "parcelQueue",
      parcelTopic.topic,
      parcelTopic.consume(handle, redelivery)
    );

  test("acknowledges a handled message", async () => {
    const POST = parcelRoute(() => Effect.void);

    const response = await POST(taskRequest(await bearer(tasksInvoker)));

    expect(response.status).toBe(200);
  });

  test("acknowledges an invalid payload", async () => {
    let handled = false;
    const POST = parcelRoute(() =>
      Effect.sync(() => {
        handled = true;
      })
    );

    const response = await POST(
      taskRequest(await bearer(tasksInvoker), JSON.stringify({ parcelId: "" }))
    );

    expect(response.status).toBe(200);
    expect(handled).toBe(false);
  });

  test("acknowledges a failure that can never succeed", async () => {
    const POST = parcelRoute(
      () => Effect.fail(new ParcelNotReadyError()),
      () => QueueRedelivery.Never()
    );

    const response = await POST(taskRequest(await bearer(tasksInvoker)));

    expect(response.status).toBe(200);
  });

  test.each([
    ["backoff", () => QueueRedelivery.WithBackoff()],
    [
      "a due instant",
      () =>
        QueueRedelivery.At({
          instant: Temporal.Now.instant().add({ minutes: 5 }),
        }),
    ],
    ["the default retry", () => QueueRedelivery.Default()],
  ])(
    "answers 500 to a transient failure retried with %s",
    async (_, redelivery) => {
      const POST = parcelRoute(
        () => Effect.fail(new ParcelNotReadyError()),
        redelivery
      );

      const response = await POST(taskRequest(await bearer(tasksInvoker)));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Queue delivery failed" });
    }
  );

  test("acknowledges a preview message at the preview delivery limit", async () => {
    setHost({ ...containerHost, VERCEL_ENV: "preview" });
    const POST = parcelRoute(() => Effect.fail(new ParcelNotReadyError()));

    const early = await POST(
      taskRequest(await bearer(tasksInvoker), undefined, {
        "x-cloudtasks-taskretrycount": "3",
      })
    );
    const last = await POST(
      taskRequest(await bearer(tasksInvoker), undefined, {
        "x-cloudtasks-taskretrycount": "4",
      })
    );

    expect([early.status, last.status]).toEqual([500, 200]);
  });
});

describe("defineQueueRoute", () => {
  test("keeps Vercel Queues on Vercel, the default host", async () => {
    for (const host of [undefined, "vercel"]) {
      setHost({ ...containerHost, WORKSPACE_RUNTIME_HOST: host });
      const { POST, deliveries } = recordingRoute();

      const response = await POST(taskRequest(await bearer(tasksInvoker)));

      expect(response.status).toBe(299);
      expect(deliveries).toHaveLength(0);
    }
  });

  test("never builds the Vercel handler on a container host", async () => {
    handleCallback.mockClear();
    const { POST, deliveries } = recordingRoute();

    const response = await POST(taskRequest(await bearer(tasksInvoker)));

    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(1);
    expect(handleCallback).not.toHaveBeenCalled();
  });
});
