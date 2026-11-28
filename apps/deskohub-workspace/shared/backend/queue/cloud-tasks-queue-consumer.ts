import "server-only";

import { Effect, Match, Option, Schema } from "effect";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { cloudTasksInvoker } from "@/shared/backend/google-cloud/google-invokers";
import {
  defineServiceRoute,
  requireGoogleInvoker,
} from "@/shared/backend/service-route";
import {
  type QueueConsumer,
  type QueueDelivery,
  type QueueDeliveryOutcome,
  queueDeliveryModeForStage,
} from "./queue-consumer";
import type { WorkspaceQueueTopic } from "./workspace-queue-topics";

const parseRetryCount = (value: string | null) => {
  const count = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
};

/**
 * The delivery metadata Cloud Tasks sends with a task. `deliveryCount` is
 * 1-based like Vercel's: `X-CloudTasks-TaskRetryCount` counts every earlier
 * dispatch, including ones answered with a 5xx, while
 * `X-CloudTasks-TaskExecutionCount` leaves those out and so never grows
 * while this adapter answers 500 for a retry.
 */
const cloudTasksDeliveryMetadata = (
  headers: Headers,
  topic: WorkspaceQueueTopic
): Omit<QueueDelivery, "payload"> => ({
  topic,
  messageId: headers.get("x-cloudtasks-taskname") ?? "unknown",
  deliveryCount:
    parseRetryCount(headers.get("x-cloudtasks-taskretrycount")) + 1,
});

const cloudTasksLogAnnotations = (headers: Headers) => ({
  cloudTasksQueue: headers.get("x-cloudtasks-queuename") ?? undefined,
  cloudTasksEta: headers.get("x-cloudtasks-tasketa") ?? undefined,
});

const decodeJsonBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
);

/**
 * A body that fails to arrive is retried; one that arrives but is not JSON
 * can never succeed.
 */
const readJsonBody = (request: Request) =>
  Effect.tryPromise(() => request.text()).pipe(Effect.map(decodeJsonBody));

const retryResponse = () =>
  NextResponse.json({ error: "Queue delivery failed" }, { status: 500 });

const acknowledged = (status: "handled" | "invalid" | "acknowledged") =>
  NextResponse.json({ status });

/**
 * Cloud Tasks deletes a task on any 2xx and retries any other status with the
 * queue's backoff. It cannot honor a per-response delay, so `RetryAfter` and
 * `RetryAt` retry on that backoff too; deferring work past the queue's
 * retry horizon needs a successor task.
 */
const cloudTasksResponse = (outcome: QueueDeliveryOutcome) =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      Handled: () => acknowledged("handled"),
      Invalid: () => acknowledged("invalid"),
      Failed: ({ action }) =>
        action._tag === "Acknowledge"
          ? acknowledged("acknowledged")
          : retryResponse(),
    })
  );

/**
 * A Cloud Tasks queue handler on the private tasks worker. It accepts only the
 * tasks invoker's Google-signed OIDC token, then runs `consume` with the task
 * body as the payload of `topic`. An unreadable body is acknowledged, as an
 * undecodable payload is.
 */
export const defineCloudTasksQueueRoute = (
  operation: string,
  topic: WorkspaceQueueTopic,
  consume: QueueConsumer<never>
) =>
  defineServiceRoute(operation, (request) =>
    requireGoogleInvoker(request, cloudTasksInvoker()).pipe(
      Effect.andThen(
        // Task headers are logged only after the request is authenticated.
        readJsonBody(request).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.logWarning(
                  "Cloud Tasks queue message ignored: body is not JSON"
                ).pipe(Effect.as(acknowledged("invalid"))),
              onSome: (payload) =>
                consume(
                  {
                    payload,
                    ...cloudTasksDeliveryMetadata(request.headers, topic),
                  },
                  queueDeliveryModeForStage(env.VERCEL_ENV)
                ).pipe(Effect.map(cloudTasksResponse)),
            })
          ),
          Effect.catch((error) =>
            Effect.logWarning("Cloud Tasks queue message body unreadable", {
              cause: error,
            }).pipe(Effect.as(retryResponse()))
          ),
          Effect.annotateLogs(cloudTasksLogAnnotations(request.headers))
        )
      )
    )
  );
