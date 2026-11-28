import { createHash } from "node:crypto";
import { Data, Duration, Effect, Layer, Match, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { GoogleAccessToken } from "@/shared/backend/google-cloud/google-access-token";
import { currentInstant } from "@/shared/utils/temporal";
import {
  QueueMessageSendError,
  type QueuePublication,
  QueuePublisher,
  type QueuePublishOutcome,
} from "./queue-publisher";
import {
  isWorkspaceQueueTopic,
  type WorkspaceQueueTopic,
  workspaceQueueTopics,
} from "./workspace-queue-topics";

/** Where and as whom Cloud Tasks delivers Workspace queue messages. */
export type CloudTasksQueueSettings = {
  readonly projectId: string;
  readonly location: string;
  /** Base URL of the private tasks worker that consumes the queues. */
  readonly workerUrl: string;
  /** The service account Cloud Tasks signs each delivery's OIDC token as. */
  readonly invokerServiceAccountEmail: string;
  /** The OIDC audience the tasks worker accepts. */
  readonly audience: string;
};

/** Why Cloud Tasks did not accept a publication. Carries no payload or token. */
class CloudTasksPublishError extends Data.TaggedError(
  "CloudTasksPublishError"
)<{
  readonly reason:
    | "unknown-topic"
    | "invalid-message"
    | "invalid-worker-url"
    | "invalid-delay"
    | "delay-beyond-horizon"
    | "transport"
    | "timeout"
    | "status";
  readonly httpStatus?: number | undefined;
  /** The Google API error status, such as `PERMISSION_DENIED`. */
  readonly status?: GoogleRpcStatus | undefined;
}> {}

/** The canonical Google RPC error statuses. */
const googleRpcStatuses = [
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;
type GoogleRpcStatus = (typeof googleRpcStatuses)[number];

/** Cloud Tasks rejects a schedule time further ahead than this. */
const cloudTasksScheduleHorizon = Duration.days(30);

/** Bounds the request, response body included. */
const requestTimeout = Duration.seconds(10);

/** The Cloud Tasks `Task` resource fields a publication sets. */
type HttpTask = {
  readonly name: string;
  /** Omitted from the JSON when undefined: deliver now. */
  readonly scheduleTime: string | undefined;
  readonly httpRequest: {
    readonly url: string;
    readonly httpMethod: "POST";
    readonly headers: { readonly "Content-Type": "application/json" };
    /** The message JSON, base64-encoded. */
    readonly body: string;
    readonly oidcToken: {
      readonly serviceAccountEmail: string;
      readonly audience: string;
    };
  };
};

const GoogleApiErrorBody = Schema.Struct({
  error: Schema.Struct({ status: Schema.Literals(googleRpcStatuses) }),
});

/**
 * Publishes Workspace queue messages as Cloud Tasks HTTP tasks. The task name
 * derives from the idempotency key, so Cloud Tasks rejects a repeat as a
 * duplicate.
 */
export const CloudTasksQueuePublisher = (
  settings: CloudTasksQueueSettings
): Layer.Layer<QueuePublisher, never, GoogleAccessToken> =>
  Layer.effect(
    QueuePublisher,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const accessToken = yield* GoogleAccessToken;

      const settle = ({
        response,
        token,
      }: {
        readonly response: HttpClientResponse.HttpClientResponse;
        readonly token: string;
      }) =>
        Match.value(response.status).pipe(
          Match.when(
            (status) => status >= 200 && status < 300,
            () => Effect.succeed<QueuePublishOutcome>("published")
          ),
          Match.orElse(() =>
            // Drop a rejected token before the optional error body, which
            // may never arrive.
            Effect.when(
              accessToken.invalidate(token),
              Effect.succeed(response.status === 401)
            ).pipe(
              Effect.andThen(rejectionStatus(response)),
              // Only a decoded ALREADY_EXISTS proves the task exists; any
              // other 409 fails so the caller retries.
              Effect.filterOrFail(
                (status) =>
                  response.status === 409 && status === "ALREADY_EXISTS",
                (status) =>
                  new CloudTasksPublishError({
                    reason: "status",
                    httpStatus: response.status,
                    status,
                  })
              ),
              Effect.as<QueuePublishOutcome>("duplicate")
            )
          )
        );

      const createTask = ({
        topic,
        task,
      }: {
        readonly topic: WorkspaceQueueTopic;
        readonly task: HttpTask;
      }) =>
        accessToken.get.pipe(
          Effect.flatMap((token) =>
            client
              .execute(
                HttpClientRequest.post(
                  `https://cloudtasks.googleapis.com/v2/${queuePath(settings, topic)}/tasks`
                ).pipe(
                  HttpClientRequest.bearerToken(token),
                  HttpClientRequest.bodyJsonUnsafe({ task })
                )
              )
              .pipe(
                Effect.mapError(
                  () => new CloudTasksPublishError({ reason: "transport" })
                ),
                Effect.flatMap((response) => settle({ response, token })),
                Effect.timeoutOrElse({
                  duration: requestTimeout,
                  orElse: () =>
                    Effect.fail(
                      new CloudTasksPublishError({ reason: "timeout" })
                    ),
                })
              )
          )
        );

      const publishTask = ({ topic, message, options }: QueuePublication) =>
        Effect.Do.pipe(
          Effect.bind("topic", () => workspaceTopic(topic)),
          Effect.bind("scheduleTime", () =>
            scheduleTimeAfter(options.delaySeconds)
          ),
          // `retentionSeconds` has no per-task form: a Cloud Tasks queue
          // bounds every task's retries with its own `maxRetryDuration`.
          Effect.bind("task", ({ topic, scheduleTime }) =>
            httpTask({
              settings,
              topic,
              scheduleTime,
              message,
              idempotencyKey: options.idempotencyKey,
            })
          ),
          Effect.flatMap(createTask)
        );

      return {
        publish: (publication) =>
          publishTask(publication).pipe(
            Effect.withSpan("CloudTasksQueuePublisher.publish"),
            Effect.mapError(
              (cause) =>
                new QueueMessageSendError({ topic: publication.topic, cause })
            )
          ),
      };
    })
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * The task ID for an idempotency key: its SHA-256 in base64url, which fits
 * the Cloud Tasks name grammar and spreads names evenly, as Cloud Tasks
 * recommends.
 */
export const taskId = (idempotencyKey: string) =>
  createHash("sha256").update(idempotencyKey).digest("base64url");

const queuePath = (
  { projectId, location }: CloudTasksQueueSettings,
  topic: WorkspaceQueueTopic
) => `projects/${projectId}/locations/${location}/queues/${topic}`;

const workspaceTopic = (topic: string) =>
  Effect.succeed(topic).pipe(
    Effect.filterOrFail(
      isWorkspaceQueueTopic,
      () => new CloudTasksPublishError({ reason: "unknown-topic" })
    )
  );

const scheduleTimeAfter = (delaySeconds: number | undefined) =>
  Option.fromNullishOr(delaySeconds).pipe(
    Option.filter((delay) => delay !== 0),
    Option.match({
      onNone: () => Effect.undefined,
      onSome: (delay) =>
        Effect.succeed(delay).pipe(
          Effect.filterOrFail(
            (delay) => Number.isFinite(delay) && delay >= 0,
            () => new CloudTasksPublishError({ reason: "invalid-delay" })
          ),
          Effect.filterOrFail(
            (delay) => delay <= Duration.toSeconds(cloudTasksScheduleHorizon),
            () => new CloudTasksPublishError({ reason: "delay-beyond-horizon" })
          ),
          Effect.flatMap((delay) =>
            currentInstant.pipe(
              Effect.map((now) =>
                now.add({ milliseconds: Math.round(delay * 1000) }).toString()
              )
            )
          )
        ),
    })
  );

const httpTask = ({
  settings,
  topic,
  scheduleTime,
  message,
  idempotencyKey,
}: {
  readonly settings: CloudTasksQueueSettings;
  readonly topic: WorkspaceQueueTopic;
  readonly scheduleTime: string | undefined;
  readonly message: QueuePublication["message"];
  readonly idempotencyKey: string;
}) =>
  Effect.Do.pipe(
    Effect.bind("url", () => workerUrl({ settings, topic })),
    Effect.bind("body", () => encodedMessage(message)),
    Effect.map(
      ({ url, body }): HttpTask => ({
        name: `${queuePath(settings, topic)}/tasks/${taskId(idempotencyKey)}`,
        scheduleTime,
        httpRequest: {
          url,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          oidcToken: {
            serviceAccountEmail: settings.invokerServiceAccountEmail,
            audience: settings.audience,
          },
        },
      })
    )
  );

const workerUrl = ({
  settings,
  topic,
}: {
  readonly settings: CloudTasksQueueSettings;
  readonly topic: WorkspaceQueueTopic;
}) =>
  Option.fromNullishOr(
    URL.parse(workspaceQueueTopics[topic], settings.workerUrl)
  ).pipe(
    Option.match({
      onNone: () =>
        Effect.fail(
          new CloudTasksPublishError({ reason: "invalid-worker-url" })
        ),
      onSome: ({ href }) => Effect.succeed(href),
    })
  );

/** The message as base64 JSON; a value JSON cannot encode fails typed. */
const encodedMessage = (message: QueuePublication["message"]) =>
  Effect.try({
    try: (): string | undefined => JSON.stringify(message),
    catch: () => new CloudTasksPublishError({ reason: "invalid-message" }),
  }).pipe(
    Effect.filterOrFail(
      (json): json is string => json !== undefined,
      () => new CloudTasksPublishError({ reason: "invalid-message" })
    ),
    Effect.map((json) => Buffer.from(json).toString("base64"))
  );

/** A failed response's Google API status, read without its message. */
const rejectionStatus = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GoogleApiErrorBody)),
    Effect.map(({ error }) => error.status),
    Effect.orElseSucceed(() => undefined)
  );
