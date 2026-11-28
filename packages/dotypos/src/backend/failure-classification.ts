import {
  type DotyposOperation,
  type DotyposReadFailure,
  DotyposRejected,
  type DotyposRequest,
  DotyposUnavailable,
  DotyposUncertain,
  DotyposVersionConflict,
} from "../errors";
import type { DotyposWireFailure } from "./api";
import {
  type DotyposRequestFailure,
  dotyposRequestProfiles,
} from "./request-profiles";

/** The public operation a caller invoked and the wire request it was making. */
export type DotyposCall<Request extends DotyposRequest = DotyposRequest> = {
  readonly operation: DotyposOperation;
  readonly request: Request;
};

type DotyposFailureFields = {
  readonly operation: DotyposOperation;
  readonly request?: DotyposRequest;
  readonly httpStatus?: number;
  readonly message?: string;
  readonly cause?: unknown;
};

/** Which column of the classification table a request uses. */
type DotyposRequestKind = "read" | "write" | "conditional";

const requestKind = (request: DotyposRequest): DotyposRequestKind => {
  const profile = dotyposRequestProfiles[request];
  if (profile.effect === "read") return "read";
  return profile.repeat === "conditional" ? "conditional" : "write";
};

/** Only a write may have been applied, so only a write's failure can be uncertain. */
const surfacesUncertainty = <Request extends DotyposRequest>(
  request: Request,
  failure: DotyposUncertain
): failure is DotyposUncertain & DotyposRequestFailure<Request> =>
  requestKind(request) !== "read";

/** Only a conditional write can meet a version conflict. */
const surfacesVersionConflict = <Request extends DotyposRequest>(
  request: Request,
  failure: DotyposVersionConflict
): failure is DotyposVersionConflict & DotyposRequestFailure<Request> =>
  requestKind(request) === "conditional";

const connectionFailedMessage = "Failed to connect to Dotypos";

/**
 * Classifies one failed attempt of a request into a public outcome by the
 * request's kind. A write that failed after it may have been sent is
 * uncertain; an access-token failure happens before the request is sent, so
 * it never is.
 */
export const classifyWireFailure = <Request extends DotyposRequest>(
  failure: DotyposWireFailure,
  call: DotyposCall<Request>
): DotyposRequestFailure<Request> => {
  const fields = {
    operation: call.operation,
    request: call.request,
    ...(failure.cause !== undefined && { cause: failure.cause }),
  };
  const { outcome } = failure;
  switch (outcome.kind) {
    case "status":
      return failure.fromAccessToken
        ? classifyAccessTokenStatus(outcome.status, fields)
        : classifyStatus(outcome.status, fields);
    case "transport":
      return failure.fromAccessToken
        ? new DotyposUnavailable({
            ...fields,
            reason: "transport",
            message: connectionFailedMessage,
          })
        : unavailableOrUncertain("transport", {
            ...fields,
            message: connectionFailedMessage,
          });
    case "unreadable":
      return failure.fromAccessToken
        ? new DotyposRejected({ ...fields, reason: "invalid-response" })
        : rejectedOrUncertain(fields);
  }
};

const classifyStatus = <Request extends DotyposRequest>(
  status: number,
  base: DotyposFailureFields & { readonly request: Request }
): DotyposRequestFailure<Request> => {
  const fields = {
    ...base,
    httpStatus: status,
    message: "Dotypos API request failed",
  };
  if (status < 400) return rejectedOrUncertain(fields);
  if (status >= 500) return unavailableOrUncertain("server", fields);
  return classifyClientErrorStatus(status, fields);
};

/** A 4xx answer: Dotypos refused the request without applying it. */
const classifyClientErrorStatus = <Request extends DotyposRequest>(
  status: number,
  fields: DotyposFailureFields & {
    readonly request: Request;
    readonly httpStatus: number;
  }
): DotyposRequestFailure<Request> => {
  if (status === 401 || status === 403) {
    return new DotyposRejected({ ...fields, reason: "unauthorized" });
  }
  if (status === 404) {
    return new DotyposRejected({ ...fields, reason: "not-found" });
  }
  if (status === 409 || status === 412) {
    const conflict = new DotyposVersionConflict(fields);
    if (surfacesVersionConflict(fields.request, conflict)) return conflict;
  }
  if (status === 429) {
    return new DotyposUnavailable({ ...fields, reason: "rate-limited" });
  }
  return new DotyposRejected({ ...fields, reason: "invalid-request" });
};

/** The token request runs before the addressed request, so nothing was applied. */
const classifyAccessTokenStatus = (
  status: number,
  base: DotyposFailureFields
): DotyposReadFailure => {
  const fields = {
    ...base,
    httpStatus: status,
    message: "Dotypos access token request failed",
  };
  if (status < 400) {
    return new DotyposRejected({ ...fields, reason: "invalid-response" });
  }
  if (status === 429) {
    return new DotyposUnavailable({ ...fields, reason: "rate-limited" });
  }
  if (status >= 500) {
    return new DotyposUnavailable({ ...fields, reason: "server" });
  }
  return new DotyposRejected({ ...fields, reason: "unauthorized" });
};

const unavailableOrUncertain = <Request extends DotyposRequest>(
  reason: "server" | "transport" | "timeout",
  fields: DotyposFailureFields & { readonly request: Request }
): DotyposRequestFailure<Request> => {
  const uncertain = new DotyposUncertain({ ...fields, reason });
  return surfacesUncertainty(fields.request, uncertain)
    ? uncertain
    : new DotyposUnavailable({ ...fields, reason });
};

const rejectedOrUncertain = <Request extends DotyposRequest>(
  fields: DotyposFailureFields & { readonly request: Request }
): DotyposRequestFailure<Request> => {
  const uncertain = new DotyposUncertain({
    ...fields,
    reason: "invalid-response",
  });
  return surfacesUncertainty(fields.request, uncertain)
    ? uncertain
    : new DotyposRejected({ ...fields, reason: "invalid-response" });
};

/** The per-request timeout fired. A write may already have been sent. */
export const dotyposTimeout = <Request extends DotyposRequest>(
  call: DotyposCall<Request>
): DotyposRequestFailure<Request> =>
  unavailableOrUncertain("timeout", {
    ...call,
    message: connectionFailedMessage,
  });

/**
 * Dotypos answered 2xx with a body the package cannot use. `httpStatus` is set
 * only where the failure carried a status before the outcome tags.
 */
export const dotyposInvalidResponse = <Request extends DotyposRequest>(
  call: DotyposCall<Request>,
  details: {
    readonly message: string;
    readonly httpStatus?: number;
    readonly cause?: unknown;
  }
): DotyposRequestFailure<Request> =>
  rejectedOrUncertain({
    ...call,
    ...details,
  });

/** The caller's input is invalid, so no request was sent. */
export const dotyposInvalidRequest = (
  operation: DotyposOperation,
  message: string,
  cause?: unknown
) =>
  new DotyposRejected({
    operation,
    reason: "invalid-request",
    message,
    ...(cause !== undefined && { cause }),
  });
