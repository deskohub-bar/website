import type {
  ImageDigest,
  WorkspaceStackConfig,
  WorkspaceWorkload,
} from "./config/stack-config";
import type {
  LiveTemplate,
  TrafficReadback,
} from "./release/release-reconciler";
import type { ReleaseRecord } from "./release/release-record";
import { trafficGenerationAnnotation } from "./resources/service-declarations";
import { workloadUrl } from "./resources/workload-names";

/** One traffic status row as Cloud Run reports it after an apply. */
export interface ObservedTrafficStatus {
  readonly revision: string;
  readonly percent: number;
  readonly tag?: string | undefined;
}

/** The fields of a live Cloud Run service the stack checks after apply. */
export interface ObservedService {
  readonly workload: WorkspaceWorkload;
  readonly uri: string | undefined;
  readonly urls: ReadonlyArray<string>;
  readonly ingress: string | undefined;
  readonly invokerIamDisabled: boolean;
  readonly terminalConditionState: string | undefined;
  readonly reconciling: boolean;
  readonly traffic: ReadonlyArray<ObservedTrafficStatus>;
  /** Image digest of each revision that carries traffic or a tag. */
  readonly revisionDigests: Readonly<Record<string, ImageDigest>>;
  /** Service annotations as Cloud Run reports them. */
  readonly annotations: Readonly<Record<string, string>>;
  /** The revision name the live service template declares, if any. */
  readonly templateRevision?: string | undefined;
  /** The digest the live template's container image pins, if any. */
  readonly templateImageDigest?: ImageDigest | undefined;
  /** The spec fingerprint annotation on the live template, if any. */
  readonly templateSpecFingerprint?: string | undefined;
  /** The live template's own revision is ready, routed or not. */
  readonly templateReady?: boolean | undefined;
}

/** The live API template, or null while the service does not exist. */
export const liveTemplateOf = (
  observed: ObservedService | null
): LiveTemplate | null =>
  observed === null
    ? null
    : {
        revision: observed.templateRevision ?? null,
        imageDigest: observed.templateImageDigest ?? null,
        specFingerprint: observed.templateSpecFingerprint ?? null,
        ready: observed.templateReady === true,
      };

const observedTrafficGeneration = (observed: ObservedService) => {
  const value = observed.annotations[trafficGenerationAnnotation];
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : null;
};

export interface ReadbackDrift {
  readonly workload: WorkspaceWorkload;
  readonly field: string;
  readonly expected: string;
  readonly observed: string;
}

const expectedIngress = {
  api: "INGRESS_TRAFFIC_ALL",
  "tasks-worker": "INGRESS_TRAFFIC_ALL",
  "scheduler-worker": "INGRESS_TRAFFIC_ALL",
} satisfies Record<WorkspaceWorkload, string>;

/**
 * The release-relevant view of live traffic: the single revision holding
 * all untagged traffic and its digest, or nulls while traffic is split,
 * reconciling or failed.
 */
export const trafficReadback = (observed: ObservedService): TrafficReadback => {
  const serving = observed.traffic.filter((entry) => entry.percent > 0);
  const [only] = serving;
  if (
    observed.reconciling ||
    observed.terminalConditionState !== "CONDITION_SUCCEEDED" ||
    serving.length !== 1 ||
    only === undefined ||
    only.percent !== 100
  ) {
    return {
      servingRevision: null,
      servingImageDigest: null,
      trafficGeneration: observedTrafficGeneration(observed),
    };
  }
  return {
    servingRevision: only.revision,
    servingImageDigest: observed.revisionDigests[only.revision] ?? null,
    trafficGeneration: observedTrafficGeneration(observed),
  };
};

/**
 * Drift between a live service and its declaration's fixed contract:
 * ingress, invoker IAM (required on every service), and the deterministic
 * URL that the frontend, queues and schedules target and mint ID tokens for.
 */
export const serviceReadbackDrift = (
  config: WorkspaceStackConfig,
  observed: ObservedService
): ReadonlyArray<ReadbackDrift> => {
  const drift = (field: string, expected: string, actual: string) =>
    expected === actual
      ? []
      : [{ workload: observed.workload, field, expected, observed: actual }];
  return [
    ...drift(
      "ingress",
      expectedIngress[observed.workload],
      observed.ingress ?? "<unset>"
    ),
    ...drift(
      "invokerIamDisabled",
      "false",
      String(observed.invokerIamDisabled)
    ),
    ...drift(
      "url",
      workloadUrl(config, observed.workload),
      observed.urls.find(
        (url) => url === workloadUrl(config, observed.workload)
      ) ??
        observed.uri ??
        "<unset>"
    ),
  ];
};

/**
 * Drift between the live API service and the release record: untagged
 * traffic must reach the expected release's revision and digest under the
 * record's traffic generation. Split, reconciling or failed traffic is
 * reported as unavailable rather than passing.
 */
export const apiTrafficDrift = (
  record: ReleaseRecord,
  observed: ObservedService
): ReadonlyArray<ReadbackDrift> => {
  const expected = record.pendingApply?.target ?? record.active;
  const readback = trafficReadback(observed);
  const drift = (field: string, wanted: string, actual: string | null) =>
    wanted === actual
      ? []
      : [
          {
            workload: "api" as const,
            field,
            expected: wanted,
            observed: actual ?? "<unavailable>",
          },
        ];
  return [
    ...drift(
      "trafficGeneration",
      String(record.trafficGeneration),
      readback.trafficGeneration === null
        ? null
        : String(readback.trafficGeneration)
    ),
    ...drift(
      "servingRevision",
      expected?.revision ?? "<none>",
      readback.servingRevision
    ),
    ...drift(
      "servingImageDigest",
      expected?.imageDigest ?? "<none>",
      readback.servingImageDigest
    ),
  ];
};
