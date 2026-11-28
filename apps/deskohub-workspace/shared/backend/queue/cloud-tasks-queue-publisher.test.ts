import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import {
  GoogleAccessToken,
  GoogleAccessTokenError,
} from "@/shared/backend/google-cloud/google-access-token";
import {
  CloudTasksQueuePublisher,
  taskId,
} from "./cloud-tasks-queue-publisher";
import { type QueuePublication, QueuePublisher } from "./queue-publisher";

const settings = {
  projectId: "deskohub-test",
  location: "europe-west3",
  workerUrl: "https://tasks-worker.example.test",
  invokerServiceAccountEmail: testEmailAddress("tasks-invoker"),
  audience: "https://tasks-worker.example.test/",
};
const accessToken = "synthetic-access-token";
const now = Date.parse("2026-11-23T10:00:00.000Z");
const queue =
  "projects/deskohub-test/locations/europe-west3/queues/workspace-paid-fulfillment";

const publication: QueuePublication = {
  topic: "workspace-paid-fulfillment",
  message: { version: 1, orderId: "order-1" },
  options: { idempotencyKey: "paid-fulfillment:order-1" },
};

type SentRequest = {
  readonly url: string;
  readonly headers: Headers;
  readonly body: {
    readonly task: {
      readonly name: string;
      readonly scheduleTime?: string;
      readonly httpRequest: { readonly body: string };
    };
  };
};

const publish = async (
  input: QueuePublication,
  {
    respond = () => Response.json({}),
    token = Effect.succeed(accessToken),
    workerUrl = settings.workerUrl,
  }: {
    respond?: () => Response | Promise<Response>;
    token?: Effect.Effect<string, GoogleAccessTokenError>;
    workerUrl?: string;
  } = {}
) => {
  const requests: SentRequest[] = [];
  const invalidated: string[] = [];
  const fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(await new Response(init?.body).text()),
      });
      return respond();
    },
    { preconnect: globalThis.fetch.preconnect }
  );
  const result = await Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const publisher = yield* QueuePublisher;
    const fiber = yield* Effect.forkChild(publisher.publish(input));
    yield* TestClock.adjust("11 seconds");
    return yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudTasksQueuePublisher({ ...settings, workerUrl }).pipe(
          Layer.provide(
            Layer.succeed(GoogleAccessToken, {
              get: token,
              invalidate: (rejected) =>
                Effect.sync(() => {
                  invalidated.push(rejected);
                }),
            })
          )
        ),
        TestClock.layer()
      )
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.result,
    Effect.runPromise
  );
  return { result, requests, invalidated };
};

describe("CloudTasksQueuePublisher", () => {
  test("creates an authorized HTTP task carrying only the message", async () => {
    const { result, requests } = await publish(publication);

    expect(result).toMatchObject({ success: "published" });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(
      `https://cloudtasks.googleapis.com/v2/${queue}/tasks`
    );
    expect(request?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    const task = request?.body.task;
    expect(task).toEqual({
      name: `${queue}/tasks/${taskId(publication.options.idempotencyKey)}`,
      httpRequest: {
        url: "https://tasks-worker.example.test/api/queues/workspace/paid-fulfillment",
        httpMethod: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.any(String),
        oidcToken: {
          serviceAccountEmail: settings.invokerServiceAccountEmail,
          audience: settings.audience,
        },
      },
    });
    const body = Buffer.from(task?.httpRequest.body ?? "", "base64");
    expect(JSON.parse(body.toString("utf8"))).toEqual(publication.message);
  });

  test("names tasks deterministically from the idempotency key", () => {
    const id = taskId("paid-fulfillment:order-1");

    // SHA-256 in base64url; changing it renames every pending task.
    expect(id).toBe("eWUfUv5h-KHd7jRFOi228FORHtAhX6e6sfghtS30RYM");
    expect(taskId("paid-fulfillment:order-1")).toBe(id);
    expect(taskId("paid-fulfillment:order-2")).not.toBe(id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    expect(taskId("x".repeat(10_000))).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
  });

  test("schedules a delayed message from the current time", async () => {
    const { requests } = await publish({
      ...publication,
      options: { ...publication.options, delaySeconds: 90 },
    });

    expect(requests[0]?.body.task.scheduleTime).toBe("2026-11-23T10:01:30Z");
  });

  test("leaves a message without delay unscheduled", async () => {
    const { requests } = await publish({
      ...publication,
      options: { ...publication.options, delaySeconds: 0 },
    });

    expect(requests[0]?.body.task).not.toHaveProperty("scheduleTime");
  });

  test("reports an existing task name as a duplicate", async () => {
    const { result } = await publish(publication, {
      respond: () =>
        Response.json(
          { error: { code: 409, status: "ALREADY_EXISTS" } },
          { status: 409 }
        ),
    });

    expect(result).toMatchObject({ success: "duplicate" });
  });

  test("fails with the API status but without the token or message", async () => {
    const { result } = await publish(publication, {
      respond: () =>
        Response.json(
          { error: { code: 403, status: "PERMISSION_DENIED" } },
          { status: 403 }
        ),
    });

    expect(result).toMatchObject({
      failure: {
        _tag: "QueueMessageSendError",
        topic: publication.topic,
        cause: {
          _tag: "CloudTasksPublishError",
          reason: "status",
          httpStatus: 403,
          status: "PERMISSION_DENIED",
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain("order-1");
  });

  test("drops a rejected access token", async () => {
    const { result, invalidated } = await publish(publication, {
      respond: () =>
        Response.json(
          { error: { code: 401, status: "UNAUTHENTICATED" } },
          { status: 401 }
        ),
    });

    expect(result).toMatchObject({
      failure: { cause: { reason: "status", httpStatus: 401 } },
    });
    expect(invalidated).toEqual([accessToken]);
  });

  test("drops a rejected access token whose error body never arrives", async () => {
    const { result, invalidated } = await publish(publication, {
      respond: () =>
        new Response(new ReadableStream({ start: () => undefined }), {
          status: 401,
        }),
    });

    expect(result).toMatchObject({ failure: { cause: { reason: "timeout" } } });
    expect(invalidated).toEqual([accessToken]);
  });

  test("keeps the access token on other rejections", async () => {
    const { invalidated } = await publish(publication, {
      respond: () => new Response(null, { status: 403 }),
    });

    expect(invalidated).toEqual([]);
  });

  test("times out an error response whose body never arrives", async () => {
    const { result } = await publish(publication, {
      respond: () =>
        new Response(new ReadableStream({ start: () => undefined }), {
          status: 500,
        }),
    });

    expect(result).toMatchObject({
      failure: { cause: { _tag: "CloudTasksPublishError", reason: "timeout" } },
    });
  });

  test.each([
    ["another status", { error: { code: 409, status: "ABORTED" } }],
    ["no status", {}],
  ])("fails a conflict with %s", async (_, body) => {
    const { result } = await publish(publication, {
      respond: () => Response.json(body, { status: 409 }),
    });

    expect(result).toMatchObject({
      failure: { cause: { reason: "status", httpStatus: 409 } },
    });
  });

  test("drops an error status outside the Google RPC codes", async () => {
    const { result } = await publish(publication, {
      respond: () =>
        Response.json({ error: { status: "order-1 detail" } }, { status: 400 }),
    });

    expect(result).toMatchObject({
      failure: { cause: { reason: "status", httpStatus: 400 } },
    });
    expect(JSON.stringify(result)).not.toContain("order-1");
  });

  test.each([
    ["a value JSON cannot encode", { amount: 1n }],
    ["no value", undefined],
  ])("rejects a message with %s", async (_, message) => {
    const { result, requests } = await publish({ ...publication, message });

    expect(result).toMatchObject({
      failure: {
        _tag: "QueueMessageSendError",
        cause: { _tag: "CloudTasksPublishError", reason: "invalid-message" },
      },
    });
    expect(requests).toHaveLength(0);
  });

  test("rejects a worker URL that does not parse", async () => {
    const { result, requests } = await publish(publication, {
      workerUrl: "not a url",
    });

    expect(result).toMatchObject({
      failure: { cause: { reason: "invalid-worker-url" } },
    });
    expect(requests).toHaveLength(0);
  });

  test("fails when the request does not reach Cloud Tasks", async () => {
    const { result } = await publish(publication, {
      respond: () => Promise.reject(new TypeError("fetch failed")),
    });

    expect(result).toMatchObject({
      failure: {
        _tag: "QueueMessageSendError",
        cause: { _tag: "CloudTasksPublishError", reason: "transport" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  test("fails without a request when no access token is available", async () => {
    const { result, requests } = await publish(publication, {
      token: Effect.fail(new GoogleAccessTokenError({ reason: "status" })),
    });

    expect(result).toMatchObject({
      failure: {
        _tag: "QueueMessageSendError",
        cause: { _tag: "GoogleAccessTokenError" },
      },
    });
    expect(requests).toHaveLength(0);
  });

  test("rejects a topic that is not a Workspace queue", async () => {
    const { result, requests } = await publish({
      ...publication,
      topic: "workspace-unknown",
    });

    expect(result).toMatchObject({
      failure: {
        _tag: "QueueMessageSendError",
        topic: "workspace-unknown",
        cause: { reason: "unknown-topic" },
      },
    });
    expect(requests).toHaveLength(0);
  });

  test.each([
    [30 * 24 * 60 * 60 + 1, "delay-beyond-horizon"],
    [-1, "invalid-delay"],
    [Number.NaN, "invalid-delay"],
  ])("rejects a delay of %p seconds", async (delaySeconds, reason) => {
    const { result, requests } = await publish({
      ...publication,
      options: { ...publication.options, delaySeconds },
    });

    expect(result).toMatchObject({
      failure: { _tag: "QueueMessageSendError", cause: { reason } },
    });
    expect(requests).toHaveLength(0);
  });

  test("accepts a delay at the schedule horizon", async () => {
    const { requests } = await publish({
      ...publication,
      options: { ...publication.options, delaySeconds: 30 * 24 * 60 * 60 },
    });

    expect(requests[0]?.body.task.scheduleTime).toBe("2026-12-23T10:00:00Z");
  });
});
