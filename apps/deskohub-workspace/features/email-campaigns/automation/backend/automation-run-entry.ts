import "server-only";

import type { DotyposCustomerId } from "@deskohub/dotypos";
import type { AutomationFlowType as AutomationFlow } from "@deskohub/workspace-admin-api";
import { and, eq, inArray } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import {
  emailCampaignAutomationTriggerReceipts as receipts,
  emailCampaignAutomationRuns as runs,
  emailCampaignAutomationVersions as versions,
} from "@/db/schema";
import type { OrderId } from "@/features/order";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { CustomerEventId } from "@/shared/backend/customer-events/customer-event";
import type { AudienceFilter } from "../../audience-filter";
import type { CampaignPurpose } from "../../body/campaign-content";
import type { CampaignId } from "../../campaign-identifiers";
import { automationFlowSchema } from "../automation-flow";
import type {
  AutomationRunId,
  AutomationVersionId,
} from "../automation-identifiers";
import type {
  AutomationTriggerDisposition,
  AutomationTriggerKind,
} from "../automation-states";
import type { PassReminderContext } from "../pass-reminder-context";
import type { AutomationEvaluationFacts } from "./automation-evaluation-facts.service";
import { planReachedStep } from "./automation-reached-step";
import { appendAutomationRunProgress } from "./automation-run-timeline";
import { AutomationUnitRecheckFailed } from "./automation-unit-handler";

/** One trigger occurrence for a customer or pass of one automation. */
export type AutomationTriggerOccurrence = {
  readonly dotyposCustomerId: DotyposCustomerId;
  /** The receipt key (§1.2.7): per reservation, account, or fire and customer. */
  readonly dedupKey: string;
  readonly kind: AutomationTriggerKind;
  /** The run's `trigger_at`: the event's occurrence, or the fire time. */
  readonly at: Temporal.Instant;
  readonly eventId: CustomerEventId | null;
  readonly reservationId: WorkspaceReservationId | null;
  readonly pass?: {
    readonly id: OrderId;
    readonly context: PassReminderContext;
  };
};

/** An occurrence that starts no run, with the receipt that records why. */
type AutomationTriggerRejection = AutomationTriggerOccurrence & {
  readonly disposition: Exclude<
    AutomationTriggerDisposition,
    "started" | "already-active"
  >;
};

/** What one automation's entry recorded. */
type AutomationRunEntry = {
  readonly started: number;
  readonly alreadyActive: number;
  readonly rejected: number;
};

/** What `enterAutomationRuns` enters. */
type AutomationRunEntryInput = {
  readonly campaignId: CampaignId;
  readonly versionId: AutomationVersionId;
  /** Occurrences that start runs at the version's first step. */
  readonly admitted?: {
    /** The version's flow; its first step is where runs start. */
    readonly flow: AutomationFlow;
    readonly occurrences: readonly AutomationTriggerOccurrence[];
    /** Plans a first Condition step's units. */
    readonly facts: AutomationEvaluationFacts["Service"];
  };
  readonly rejected: readonly AutomationTriggerRejection[];
  readonly at: Temporal.Instant;
};

type AutomationFirstStepId = AutomationFlow["steps"][number]["id"];

const runScopeKey = (customerId: DotyposCustomerId, passId: OrderId | null) =>
  passId === null ? `customer:${customerId}` : `pass:${passId}`;

const occurrenceScopeKey = (occurrence: AutomationTriggerOccurrence) =>
  runScopeKey(occurrence.dotyposCustomerId, occurrence.pass?.id ?? null);

/** The earliest admitted occurrence for each independent run scope. */
const earliestOccurrenceByScope = (
  admitted: readonly AutomationTriggerOccurrence[]
): ReadonlyMap<string, AutomationTriggerOccurrence> => {
  const firstByScope = new Map<string, AutomationTriggerOccurrence>();
  for (const occurrence of admitted.toSorted(byOccurrence)) {
    const scope = occurrenceScopeKey(occurrence);
    if (!firstByScope.has(scope)) {
      firstByScope.set(scope, occurrence);
    }
  }
  return firstByScope;
};

/**
 * Starts a run, `ready` at `firstStepId` and due at `at`, for each
 * candidate without an open run; returns the runs it started.
 */
const insertStartedRuns = Effect.fnUntraced(function* (
  input: AutomationRunEntryInput,
  candidates: readonly AutomationTriggerOccurrence[],
  firstStepId: AutomationFirstStepId | undefined
) {
  if (firstStepId === undefined || candidates.length === 0) return [];
  const { db } = yield* WorkspaceTransaction;
  return yield* db
    .insert(runs)
    .values(
      candidates.map((occurrence) => ({
        campaignId: input.campaignId,
        versionId: input.versionId,
        dotyposCustomerId: occurrence.dotyposCustomerId,
        triggerKind: occurrence.kind,
        triggerAt: occurrence.at,
        triggerEventId: occurrence.eventId,
        triggerReservationId: occurrence.reservationId,
        ...(occurrence.pass && {
          triggerPassId: occurrence.pass.id,
          passReminderContext: occurrence.pass.context,
        }),
        status: "active" as const,
        stepId: firstStepId,
        phase: "ready" as const,
        stepEnteredAt: input.at,
        dueAt: input.at,
        workUnitId: null,
      }))
    )
    // Works with both the original and the scope-specific unique indexes.
    .onConflictDoNothing()
    .returning({
      id: runs.id,
      dotyposCustomerId: runs.dotyposCustomerId,
      triggerPassId: runs.triggerPassId,
    });
});

/**
 * One receipt per occurrence: `started` with its run for the occurrence
 * that started one, else `already-active`; then each rejection's own.
 */
const entryReceiptRows = (
  input: AutomationRunEntryInput,
  firstByScope: ReadonlyMap<string, AutomationTriggerOccurrence>,
  startedRuns: ReadonlyMap<string, AutomationRunId>
) => [
  ...(input.admitted?.occurrences ?? []).map((occurrence) => {
    const scope = occurrenceScopeKey(occurrence);
    const runId =
      firstByScope.get(scope) === occurrence
        ? startedRuns.get(scope)
        : undefined;
    return receiptRow(input, occurrence, {
      disposition: runId === undefined ? "already-active" : "started",
      runId: runId ?? null,
    });
  }),
  ...input.rejected.map((rejection) =>
    receiptRow(input, rejection, {
      disposition: rejection.disposition,
      runId: null,
    })
  ),
];

/** Inserts the receipts, returning those no earlier commit had taken. */
const insertReceipts = Effect.fnUntraced(function* (
  rows: ReadonlyArray<ReturnType<typeof receiptRow>>
) {
  if (rows.length === 0) return [];
  const { db } = yield* WorkspaceTransaction;
  return yield* db
    .insert(receipts)
    .values([...rows])
    .onConflictDoNothing()
    .returning({ dedupKey: receipts.dedupKey, runId: receipts.runId });
});

/** Plans the started runs' first step in the entry's transaction (D36). */
const planStartedRunsFirstStep = Effect.fnUntraced(function* (
  input: AutomationRunEntryInput,
  firstStepId: AutomationFirstStepId | undefined,
  started: ReadonlyArray<{
    readonly id: AutomationRunId;
    readonly dotyposCustomerId: DotyposCustomerId;
    readonly triggerPassId: OrderId | null;
  }>,
  firstByScope: ReadonlyMap<string, AutomationTriggerOccurrence>
) {
  if (input.admitted === undefined || firstStepId === undefined) return;
  yield* planReachedStep(input.admitted.facts, {
    campaignId: input.campaignId,
    versionId: input.versionId,
    flow: Option.some(input.admitted.flow),
    stepId: firstStepId,
    runs: started.flatMap((run) =>
      Option.toArray(
        Option.fromUndefinedOr(
          firstByScope.get(
            runScopeKey(run.dotyposCustomerId, run.triggerPassId)
          )
        )
      ).map((occurrence) => ({
        runId: run.id,
        dotyposCustomerId: run.dotyposCustomerId,
        triggerKind: occurrence.kind,
        triggerAt: occurrence.at,
        triggerReservationId: occurrence.reservationId,
      }))
    ),
    at: input.at,
    chainedSteps: 0,
  });
});

/**
 * Enters customers into one automation version (§5.6, §5.7). Each admitted
 * occurrence starts a run at the flow's first step, `ready` and due at
 * `at`. A regular trigger respects the open run per customer (D4). A pass
 * reminder has one run for the lifetime of its pass. The earliest admitted
 * occurrence in each scope can start a run. Every occurrence gets one receipt. The started runs'
 * first step is planned in the same transaction (`planReachedStep`), so
 * their conditions and due waits run within the entry's tick (D36). Call it
 * under the lifecycle lock after the caller's rechecks.
 *
 * Runs insert before receipts, so a concurrent entry of the same customer
 * waits on the one-open-run index and then sees the run. A receipt key a
 * concurrent commit took meanwhile fails the commit with
 * `AutomationUnitRecheckFailed`, rolling the runs back: the unit drops and
 * its subjects are replanned, when the key is no longer free.
 */
export const enterAutomationRuns = Effect.fn("automationRuns.enter")(function* (
  input: AutomationRunEntryInput
) {
  const admitted = input.admitted?.occurrences ?? [];
  const firstStepId = input.admitted?.flow.steps[0]?.id;
  const firstByScope = earliestOccurrenceByScope(admitted);
  const inserted = yield* insertStartedRuns(
    input,
    [...firstByScope.values()],
    firstStepId
  );
  const startedRuns = new Map<string, AutomationRunId>(
    inserted.map((run) => [
      runScopeKey(run.dotyposCustomerId, run.triggerPassId),
      run.id,
    ])
  );

  const written = yield* insertReceipts(
    entryReceiptRows(input, firstByScope, startedRuns)
  );
  const startedReceipts = written.filter(({ runId }) => runId !== null).length;
  if (startedReceipts < startedRuns.size) {
    return yield* new AutomationUnitRecheckFailed({ code: "receipt-taken" });
  }

  yield* appendAutomationRunProgress(
    inserted.map((run) => ({
      runId: run.id,
      kind: "started" as const,
      stepId: firstStepId ?? null,
      at: input.at,
    }))
  );
  yield* planStartedRunsFirstStep(input, firstStepId, inserted, firstByScope);
  return {
    started: startedRuns.size,
    alreadyActive: admitted.length - startedRuns.size,
    rejected: input.rejected.length,
  } satisfies AutomationRunEntry;
});

/** Receipt keys among `dedupKeys` the automation already recorded. */
export const takenReceiptKeys = (
  campaignId: CampaignId,
  dedupKeys: readonly string[]
) =>
  Effect.flatMap(WorkspaceTransaction, ({ db }) =>
    dedupKeys.length === 0
      ? Effect.succeed(new Set<string>())
      : db
          .select({ dedupKey: receipts.dedupKey })
          .from(receipts)
          .where(
            and(
              eq(receipts.campaignId, campaignId),
              inArray(receipts.dedupKey, [...new Set(dedupKeys)])
            )
          )
          .pipe(
            Effect.map((rows) => new Set(rows.map(({ dedupKey }) => dedupKey)))
          )
  );

const byOccurrence = (
  left: AutomationTriggerOccurrence,
  right: AutomationTriggerOccurrence
) =>
  Temporal.Instant.compare(left.at, right.at) ||
  left.dedupKey.localeCompare(right.dedupKey);

const receiptRow = (
  input: {
    readonly campaignId: CampaignId;
    readonly versionId: AutomationVersionId;
    readonly at: Temporal.Instant;
  },
  occurrence: AutomationTriggerOccurrence,
  outcome: {
    readonly disposition: AutomationTriggerDisposition;
    readonly runId: AutomationRunId | null;
  }
) => ({
  campaignId: input.campaignId,
  dedupKey: occurrence.dedupKey,
  versionId: input.versionId,
  customerEventId: occurrence.eventId,
  dotyposCustomerId: occurrence.dotyposCustomerId,
  disposition: outcome.disposition,
  runId: outcome.runId,
  receivedAt: input.at,
});

/** What entering a version needs: its entry audience, purpose and flow. */
type AutomationEntryVersion = {
  readonly id: AutomationVersionId;
  readonly campaignId: CampaignId;
  readonly purpose: CampaignPurpose;
  readonly audienceFilter: AudienceFilter;
  /** None when the stored flow no longer decodes, or has no step: a domain defect. */
  readonly flow: Option.Option<AutomationFlow>;
};

const decodeFlow = Schema.decodeUnknownOption(automationFlowSchema);

/** The versions by id, with their flows decoded. */
export const loadAutomationEntryVersions = Effect.fn(
  "automationVersions.loadEntryVersions"
)(function* (versionIds: readonly AutomationVersionId[]) {
  const { db } = yield* WorkspaceTransaction;
  const rows =
    versionIds.length === 0
      ? []
      : yield* db
          .select({
            id: versions.id,
            campaignId: versions.campaignId,
            purpose: versions.purpose,
            audienceFilter: versions.audienceFilter,
            flow: versions.flow,
          })
          .from(versions)
          .where(inArray(versions.id, [...new Set(versionIds)]));
  const loaded: ReadonlyMap<AutomationVersionId, AutomationEntryVersion> =
    new Map(
      rows.map(({ flow, ...version }) => [
        version.id,
        {
          ...version,
          flow: decodeFlow(flow).pipe(
            Option.filter(({ steps }) => steps.length > 0)
          ),
        },
      ])
    );
  return loaded;
});
