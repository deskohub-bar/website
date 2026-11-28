export declare const WORKSPACE_E2E_FLOW_IDS: readonly [
  "checkout-cowork",
  "checkout-meeting-room",
  "checkout-office",
  "checkout-table",
  "payments",
  "discounts",
  "referrals",
  "agent-booking",
  "account",
  "admin",
  "email-campaigns",
  "access-codes",
  "public-site",
  "webkit",
];

export type WorkflowE2EFlowId = (typeof WORKSPACE_E2E_FLOW_IDS)[number];

export declare const WORKSPACE_E2E_FLOW_SHORT_CODES: Readonly<
  Record<WorkflowE2EFlowId, string>
>;

export declare const WORKSPACE_E2E_STATUS_MAX_LENGTH: number;
export declare const WORKSPACE_E2E_SUPERSEDED_DESCRIPTION: string;

export type ParsedE2EFlowsSuccess = {
  readonly ok: true;
  readonly kind: "all" | "none" | "subset";
  readonly flows: string;
  readonly selected: readonly WorkflowE2EFlowId[];
  readonly runE2E: boolean;
  readonly installWebkit: boolean;
};

export type ParsedE2EFlowsFailure = {
  readonly ok: false;
  readonly error: string;
};

export type ParsedE2EFlowsResult =
  | ParsedE2EFlowsSuccess
  | ParsedE2EFlowsFailure;

export declare const validFlowListMessage: () => string;
export declare const parseFlowTokens: (
  tokens: readonly string[]
) => ParsedE2EFlowsResult;
export declare const parseFlowsInput: (raw: string) => ParsedE2EFlowsResult;
export declare const parsePrBodyE2EFlows: (
  body: string
) => ParsedE2EFlowsResult;

export declare const formatE2EStatusDescription: (input: {
  readonly kind:
    | "failed"
    | "partial"
    | "passed"
    | "restored"
    | "running"
    | "same-tree-passed"
    | "skipped-none";
  readonly flows?: string;
  readonly sourceSha?: string;
}) => string;

export type ClassifiedE2EStatus =
  | { readonly kind: "superseded" }
  | { readonly kind: "other" }
  | {
      readonly kind: "carried-passed";
      readonly selected: readonly WorkflowE2EFlowId[];
      readonly sourceSha: string;
    }
  | {
      readonly kind:
        | "failed"
        | "partial"
        | "passed"
        | "restored"
        | "running"
        | "skipped-none";
      readonly selected: readonly WorkflowE2EFlowId[];
    };

export declare const classifyE2EStatusDescription: (
  description: string
) => ClassifiedE2EStatus;

export declare const unionFlowIds: (
  ...lists: readonly (readonly WorkflowE2EFlowId[])[]
) => readonly WorkflowE2EFlowId[];

export declare const diffFlowIds: (
  requested: readonly WorkflowE2EFlowId[],
  covered: readonly WorkflowE2EFlowId[]
) => readonly WorkflowE2EFlowId[];

export type GitHubCommitStatusRecord = {
  readonly context?: string;
  readonly creator?: { readonly login?: string } | null;
  readonly description?: string;
  readonly id?: number;
  readonly state?: string;
  readonly target_url?: string;
};

export type CarriedCoverageSource = {
  readonly sourceSha: string;
  readonly flows: readonly WorkflowE2EFlowId[];
  readonly flowsCsv: string;
};

export type CommitStatusFlowSummary = {
  readonly latestState: string;
  readonly latestDescription: string;
  readonly latestKind: string;
  readonly latestRunKind: string;
  readonly latestRunState: string;
  readonly passedFlows: readonly WorkflowE2EFlowId[];
  readonly passedFlowsCsv: string;
  readonly realPassedFlows: readonly WorkflowE2EFlowId[];
  readonly realPassedFlowsCsv: string;
  readonly carriedPassedFlows: readonly WorkflowE2EFlowId[];
  readonly carriedPassedFlowsCsv: string;
  readonly carriedSources: readonly CarriedCoverageSource[];
  readonly failedFlows: readonly WorkflowE2EFlowId[];
  readonly failedFlowsCsv: string;
  readonly carriedSourceSha: string;
  readonly coverageSource: "carried" | "none" | "real";
  readonly runningFlows: readonly WorkflowE2EFlowId[];
  readonly runningFlowsCsv: string;
  readonly runningDescription: string;
  readonly runningTargetUrl: string;
  readonly activeRuns: readonly {
    readonly description: string;
    readonly targetUrl: string;
    readonly flows: readonly WorkflowE2EFlowId[];
  }[];
  readonly anyPassed: boolean;
};

export declare const summarizeCommitStatuses: (
  statuses: readonly GitHubCommitStatusRecord[],
  options?: {
    readonly context?: string;
    readonly creator?: string;
    readonly includeCarried?: boolean;
  }
) => CommitStatusFlowSummary;

export declare const findCoveringCarriedSource: (
  carriedSources: readonly CarriedCoverageSource[],
  requestedSelected: readonly WorkflowE2EFlowId[]
) => CarriedCoverageSource | null;
