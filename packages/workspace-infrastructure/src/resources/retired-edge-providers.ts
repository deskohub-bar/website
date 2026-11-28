import { alchemyLabelKeys, hasAlchemyLabels } from "@alchemy.run/gcp/Labels";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceClass } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  type GoogleApiNoAnswer,
  type GoogleApiRetryPolicy,
  makeGoogleApi,
} from "../google-api";

/**
 * Deletion-only providers for the custom edge resource types retired when
 * the stack moved to IAM-private Cloud Run (#1450).
 *
 * The active stack never declares these resources. Keeping minimal
 * deletion-only providers registered lets a locked `alchemy destroy`
 * (`cleanup-only`) cleanly drain a pre-rename stack whose state still
 * holds saved `DeskohubWorkspace.EdgeBackendService` or
 * `DeskohubWorkspace.EdgeSecurityPolicy` rows.
 */

interface RetiredEdgeProps {
  readonly project: string;
  readonly name: string;
}

interface RetiredEdgeAttributes {
  readonly project: string;
  readonly name: string;
  readonly id?: string;
}

type RetiredEdgeBackendService = Resource<
  "DeskohubWorkspace.EdgeBackendService",
  RetiredEdgeProps,
  RetiredEdgeAttributes
>;

type RetiredEdgeSecurityPolicy = Resource<
  "DeskohubWorkspace.EdgeSecurityPolicy",
  RetiredEdgeProps,
  RetiredEdgeAttributes
>;

// Module-private resource handles: nothing in the stack may declare them.
const RetiredEdgeBackendService = Resource<RetiredEdgeBackendService>(
  "DeskohubWorkspace.EdgeBackendService"
);
const RetiredEdgeSecurityPolicy = Resource<RetiredEdgeSecurityPolicy>(
  "DeskohubWorkspace.EdgeSecurityPolicy"
);

/** Creating or updating a retired edge resource is always refused. */
class RetiredEdgeResource extends Data.TaggedError("RetiredEdgeResource")<{
  readonly resourceType: string;
}> {
  override get message() {
    return `${this.resourceType} is retired and only supports deletion of pre-rename stack state`;
  }
}

/** A Compute request during retired edge teardown failed or was refused. */
class RetiredEdgeComputeRequestFailed extends Data.TaggedError(
  "RetiredEdgeComputeRequestFailed"
)<{
  readonly resource: string;
  readonly operation: string;
  readonly status: number | null;
  readonly reason: string;
}> {
  override get message() {
    return `${this.resource}: ${this.operation} failed (${this.status ?? "no answer"}): ${this.reason}`;
  }
}

/** A global Compute delete operation finished with an error. */
class RetiredEdgeComputeOperationFailed extends Data.TaggedError(
  "RetiredEdgeComputeOperationFailed"
)<{
  readonly resource: string;
  readonly operation: string;
  readonly code: number | undefined;
  readonly reason: string | undefined;
  readonly detail: string;
}> {
  override get message() {
    return `${this.resource}: operation ${this.operation} failed (${this.reason ?? this.code ?? "error"}): ${this.detail}`;
  }
}

/** A global Compute delete operation did not finish within the waiting budget. */
class RetiredEdgeComputeOperationTimedOut extends Data.TaggedError(
  "RetiredEdgeComputeOperationTimedOut"
)<{ readonly resource: string; readonly operation: string }> {
  override get message() {
    return `${this.resource}: operation ${this.operation} did not finish within ${Duration.format(operationBudget)}`;
  }
}

/** The status of an accepted Compute delete operation could not be read. */
class RetiredEdgeComputeOperationUnreadable extends Data.TaggedError(
  "RetiredEdgeComputeOperationUnreadable"
)<{
  readonly resource: string;
  readonly operation: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.resource}: operation ${this.operation} status unreadable: ${this.reason}`;
  }
}

class ComputeOperationPending extends Data.TaggedError(
  "ComputeOperationPending"
) {}

const computeRoot = "https://compute.googleapis.com/compute/v1";

const computeRetry: GoogleApiRetryPolicy = {
  attemptTimeout: "30 seconds",
  backoff: "1 second",
  retries: 4,
};

const operationBudget = Duration.minutes(15);
const operationInterval = Duration.seconds(2);

const noAnswerReasons = {
  unreachable: "Compute API unreachable",
  "no-answer-in-time": "Compute API did not answer in time",
  "credentials-stalled": "credentials lookup stalled",
} satisfies Record<GoogleApiNoAnswer, string>;

const LiveEdgeObject = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const ComputeOperation = Schema.Struct({
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Finite),
      message: Schema.optional(Schema.String),
      errors: Schema.optional(
        Schema.Array(
          Schema.Struct({
            code: Schema.optional(Schema.String),
            message: Schema.optional(Schema.String),
          })
        )
      ),
    })
  ),
});
type ComputeOperation = typeof ComputeOperation.Type;

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({ message: Schema.String }),
    })
  )
);

const errorReason = (body: string) =>
  decodeErrorBody(body).pipe(
    Option.match({
      onNone: () => "request refused",
      onSome: ({ error }) => error.message,
    })
  );

const operationErrorCodes = (operation: ComputeOperation) =>
  (operation.error?.errors ?? []).flatMap((error) =>
    error.code === undefined ? [] : [error.code]
  );

const operationFailure = (resource: string, operation: ComputeOperation) => {
  const error = operation.error;
  const first = error?.errors?.[0];
  if (
    error === undefined ||
    (error.code === undefined && first === undefined && !error.message)
  ) {
    return undefined;
  }
  return new RetiredEdgeComputeOperationFailed({
    resource,
    operation: operation.name ?? "",
    code: error.code,
    reason: first?.code,
    detail: first?.message ?? error.message ?? "operation failed",
  });
};

const parseOwnedDescription = (description: string | undefined) => {
  if (!description?.startsWith("[alchemy ")) {
    return {};
  }
  const end = description.indexOf("]");
  if (end < 0) {
    return {};
  }
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      labels[part.slice(0, separator)] = part.slice(separator + 1);
    }
  }
  return labels;
};

const isOwnedDescription = (id: string, description: string | undefined) => {
  const labels = parseOwnedDescription(description);
  if (
    labels[alchemyLabelKeys.stack] === undefined ||
    labels[alchemyLabelKeys.stage] === undefined ||
    labels[alchemyLabelKeys.id] === undefined
  ) {
    return Effect.succeed(false);
  }
  return hasAlchemyLabels(id, labels);
};

const isAdmitted = (
  id: string,
  admittedId: string | undefined,
  live: { readonly id?: string; readonly description?: string }
) =>
  admittedId !== undefined && admittedId !== "" && live.id === admittedId
    ? Effect.succeed(true)
    : isOwnedDescription(id, live.description);

const makeRetiredEdgeComputeApi = Effect.fnUntraced(function* () {
  const googleApi = yield* makeGoogleApi();

  const send = <A>(
    resource: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: HttpClientResponse.HttpClientResponse
    ) => Effect.Effect<A, RetiredEdgeComputeRequestFailed> | undefined
  ) => {
    const failed = (status: number | null, reason: string) =>
      new RetiredEdgeComputeRequestFailed({
        resource,
        operation,
        status,
        reason,
      });
    return googleApi.call({
      request: request.pipe(HttpClientRequest.acceptJson),
      policy: computeRetry,
      handle: (response) =>
        handle(response) ??
        response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) =>
            Effect.fail(failed(response.status, errorReason(body)))
          )
        ),
      transientStatus: (status) =>
        failed(status, `Compute answered HTTP ${status}`),
      noAnswer: (cause) => failed(null, noAnswerReasons[cause]),
      credentialsUnavailable: () => failed(null, "credentials unavailable"),
    });
  };

  const decodeJson =
    <A>(body: Schema.Decoder<A>, resource: string, operation: string) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(body)),
        Effect.mapError(
          () =>
            new RetiredEdgeComputeRequestFailed({
              resource,
              operation,
              status: response.status,
              reason: "unreadable Compute answer",
            })
        )
      );

  const operationAnswer =
    (resource: string, operation: string) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.status === 200
        ? decodeJson(ComputeOperation, resource, operation)(response)
        : undefined;

  const get = (resource: string, url: string) =>
    send<typeof LiveEdgeObject.Type | undefined>(
      resource,
      "get",
      HttpClientRequest.get(url),
      (response) => {
        if (response.status === 404) {
          return Effect.undefined;
        }
        return response.status === 200
          ? decodeJson(LiveEdgeObject, resource, "get")(response)
          : undefined;
      }
    );

  const remove = (resource: string, url: string) =>
    send<"gone" | ComputeOperation>(
      resource,
      "delete",
      HttpClientRequest.delete(url).pipe(
        HttpClientRequest.setUrlParam("requestId", crypto.randomUUID())
      ),
      (response) =>
        response.status === 404
          ? Effect.succeed("gone" as const)
          : operationAnswer(resource, "delete")(response)
    );

  const settle = Effect.fnUntraced(function* (
    resource: string,
    project: string,
    operation: ComputeOperation
  ) {
    const name = operation.name ?? "";
    const operationUrl = `${computeRoot}/projects/${project}/global/operations/${name}`;
    const poll = send(
      resource,
      "wait",
      HttpClientRequest.get(operationUrl),
      operationAnswer(resource, "wait")
    ).pipe(
      // A freshly started global operation can 404 briefly before becoming visible.
      Effect.retry({
        while: (error) => error.status === 404,
        times: 5,
        schedule: Schedule.exponential("250 millis"),
      }),
      Effect.filterOrFail(
        (current) => current.status === "DONE",
        () => new ComputeOperationPending()
      ),
      Effect.catchTag("RetiredEdgeComputeRequestFailed", (error) =>
        Effect.fail(
          new RetiredEdgeComputeOperationUnreadable({
            resource,
            operation: name,
            reason: error.message,
          })
        )
      ),
      Effect.retry({
        while: (error) => error._tag === "ComputeOperationPending",
        schedule: Schedule.spaced(operationInterval),
      }),
      Effect.timeoutOrElse({
        duration: operationBudget,
        orElse: () =>
          Effect.fail(
            new RetiredEdgeComputeOperationTimedOut({
              resource,
              operation: name,
            })
          ),
      })
    );
    if (operation.status !== "DONE" && name === "") {
      return yield* new RetiredEdgeComputeOperationUnreadable({
        resource,
        operation: name,
        reason: "Compute answered an unfinished operation without a name",
      });
    }
    const settled = operation.status === "DONE" ? operation : yield* poll;
    const failure = operationFailure(resource, settled);
    if (
      failure !== undefined &&
      !operationErrorCodes(settled).includes("RESOURCE_NOT_FOUND")
    ) {
      return yield* failure;
    }
  });

  return { get, remove, settle } as const;
});

const makeRetiredGlobalEdgeProvider = <
  R extends RetiredEdgeBackendService | RetiredEdgeSecurityPolicy,
>(
  resourceClass: ResourceClass<R>,
  label: string,
  collection: "backendServices" | "securityPolicies"
) =>
  Provider.effect(
    resourceClass,
    Effect.gen(function* () {
      const api = yield* makeRetiredEdgeComputeApi();
      return {
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const project = output?.project ?? olds?.project;
          const name = output?.name ?? olds?.name;
          if (project === undefined || name === undefined) {
            return undefined;
          }
          const url = `${computeRoot}/projects/${project}/global/${collection}/${name}`;
          const live = yield* api.get(`${label} ${name}`, url);
          if (live === undefined) {
            return undefined;
          }
          const attributes: RetiredEdgeAttributes =
            live.id === undefined
              ? { project, name }
              : { project, name, id: live.id };
          const owned =
            (yield* isOwnedDescription(id, live.description)) ||
            (previous?.id !== undefined &&
              previous.id !== "" &&
              previous.id === live.id);
          return owned ? attributes : Unowned(attributes);
        }),

        reconcile: () =>
          Effect.fail(
            new RetiredEdgeResource({ resourceType: resourceClass.Type })
          ),

        delete: Effect.fn(function* ({ id, olds, output }) {
          const project = output.project ?? olds?.project;
          const name = output.name ?? olds?.name;
          if (project === undefined || name === undefined) {
            return;
          }
          const resource = `${label} ${name}`;
          const url = `${computeRoot}/projects/${project}/global/${collection}/${name}`;
          // A same-name object someone else recreated is not ours to delete.
          const live = yield* api.get(resource, url);
          if (live === undefined || !(yield* isAdmitted(id, output.id, live))) {
            return;
          }
          const deleted = yield* api.remove(resource, url);
          if (deleted !== "gone") {
            yield* api.settle(resource, project, deleted);
          }
        }),
      };
    })
  );

/**
 * Deletion-only providers for saved pre-rename edge rows so locked
 * `alchemy destroy` runs can drain stacks deployed before PR 2.
 */
export const retiredEdgeProviders = Layer.mergeAll(
  makeRetiredGlobalEdgeProvider<RetiredEdgeBackendService>(
    RetiredEdgeBackendService,
    "Backend service",
    "backendServices"
  ),
  makeRetiredGlobalEdgeProvider<RetiredEdgeSecurityPolicy>(
    RetiredEdgeSecurityPolicy,
    "Security policy",
    "securityPolicies"
  )
);
