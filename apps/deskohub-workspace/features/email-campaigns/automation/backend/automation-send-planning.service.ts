import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { Array as Arr, Context, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  emailCampaignAutomationRuns as runs,
  emailCampaignAutomationVersions as versions,
} from "@/db/schema";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import type { CampaignId } from "../../campaign-identifiers";
import type {
  AutomationRunId,
  AutomationVersionId,
} from "../automation-identifiers";
import type { AutomationTriggerKind } from "../automation-states";
import { readsTriggeringVisit } from "../automation-trigger-verification";
import { isPassReminderKind } from "../automation-triggers";
import { lockAutomationForEngine } from "./automation-lifecycle-lock";
import { planAutomationRunUnits } from "./automation-run-units";

import { deliverUnitRunLimit, plannedDeliverUnit } from "./deliver";

/** What planner step 7 did, for the plan summary. */
export type AutomationSendPlan = {
  /** Runs given to a deliver unit. */
  readonly runsPlanned: number;
  /** Deliver units planned. */
  readonly unitsPlanned: number;
};

/** The plan when nothing was due. */
export const emptyAutomationSendPlan: AutomationSendPlan = {
  runsPlanned: 0,
  unitsPlanned: 0,
};

/** Runs one planning pass packs at most; the rest wait for the next tick. */
const sendPlanningRunLimit = 1_000;

interface IAutomationSendPlanning {
  /**
   * Planner step 7 (§5.9): packs unplanned `ready` runs at Send steps of
   * active automations into deliver units of at most 100 runs per version.
   * Runs its own short idempotent transaction, so overlapping planners are
   * harmless.
   */
  readonly plan: (
    at: Temporal.Instant
  ) => Effect.Effect<AutomationSendPlan, DatabaseQueryError>;
}

/** A `ready`, unowned run at its version's Send step, row-locked by the caller. */
export type DeliverStepRun = {
  readonly id: AutomationRunId;
  readonly campaignId: CampaignId;
  readonly versionId: AutomationVersionId;
  readonly triggerKind: AutomationTriggerKind;
  /**
   * Whether its Send skips pass holders: the guard before the provider
   * request decides each customer alone, so the run delivers alone.
   */
  readonly skipsPassHolders: boolean;
};

/**
 * Packs send-ready runs into deliver units of at most 100 runs per version,
 * in the given order, and each unit takes its runs by compare-and-set.
 * Pass reminders and runs whose Send skips pass holders each get a unit of
 * their own, so one customer's guard verdict or unknown provider outcome
 * never holds another's email. The
 * caller holds the automations' lifecycle locks and the runs' row locks
 * (§5.4): the planner after its locking read, a condition unit's commit for
 * the runs it just passed (D36).
 */
export const planDeliverRuns = (
  ready: readonly DeliverStepRun[],
  at: Temporal.Instant
) => {
  // A send records one recipient row per customer. Each pass needs its own
  // send, even when two pass runs target the same customer.
  const byDelivery = Map.groupBy(ready, (run) =>
    isPassReminderKind(run.triggerKind) || run.skipsPassHolders
      ? `run:${run.id}`
      : `version:${run.versionId}`
  );
  const planned = [...byDelivery.values()]
    .flatMap((ofVersion) => Arr.chunksOf(ofVersion, deliverUnitRunLimit))
    .map((chunk) => {
      const runIds = chunk.map((run) => run.id);
      return {
        runIds,
        unit: plannedDeliverUnit({
          campaignId: chunk[0].campaignId,
          versionId: chunk[0].versionId,
          runIds,
          reservations: chunk.filter((run) =>
            readsTriggeringVisit(run.triggerKind)
          ).length,
          customers: chunk.length,
          readsPassDeskLabel: chunk[0].triggerKind === "unlimited-ending",
          at,
        }),
      };
    });
  return planAutomationRunUnits(planned, at).pipe(
    Effect.map(
      (owned): AutomationSendPlan => ({
        runsPlanned: owned.reduce((total, ofUnit) => total + ofUnit.length, 0),
        unitsPlanned: owned.length,
      })
    )
  );
};

/** The run's version's Send step, when the run is at it, matching `extra`. */
const atSendStep = (extra?: SQL) => sql`exists (
    select 1 from jsonb_array_elements(${versions.flow} -> 'steps') as step
    where step ->> '_tag' = 'Send' and step ->> 'id' = ${runs.stepId}${extra ? sql` and ${extra}` : sql``}
  )`;

/** An unplanned `ready` run at its version's Send step. */
const readyToSend: SQL =
  and(
    eq(runs.status, "active"),
    eq(runs.phase, "ready"),
    isNull(runs.workUnitId),
    atSendStep()
  ) ?? sql`false`;

export class AutomationSendPlanning extends Context.Service<
  AutomationSendPlanning,
  IAutomationSendPlanning
>()("@deskohub-workspace/email-campaigns/AutomationSendPlanning") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db, transaction } = yield* WorkspaceDatabase;

      /**
       * The automations with send-ready runs that are still active, under
       * their lifecycle locks taken first (§5.4).
       */
      const lockActiveAutomations = () =>
        db
          .selectDistinct({ campaignId: runs.campaignId })
          .from(runs)
          .innerJoin(versions, eq(versions.id, runs.versionId))
          .where(readyToSend)
          .orderBy(asc(runs.campaignId))
          .pipe(
            Effect.flatMap((pending) =>
              Effect.filter(pending, ({ campaignId }) =>
                lockAutomationForEngine(campaignId).pipe(
                  Effect.map((lifecycle) => lifecycle.status === "active")
                )
              )
            ),
            Effect.map((active) => active.map(({ campaignId }) => campaignId))
          );

      /**
       * Their send-ready runs in version and id order. Runs another planner
       * holds are skipped, and the ownership CAS rechecks the rest.
       */
      const selectReadyRuns = (campaignIds: readonly CampaignId[]) =>
        db
          .select({
            id: runs.id,
            campaignId: runs.campaignId,
            versionId: runs.versionId,
            dotyposCustomerId: runs.dotyposCustomerId,
            triggerKind: runs.triggerKind,
            skipsPassHolders: atSendStep(
              sql`step -> 'skipPassHolders' = 'true'::jsonb`
            ).mapWith(Boolean),
          })
          .from(runs)
          .innerJoin(versions, eq(versions.id, runs.versionId))
          .where(and(readyToSend, inArray(runs.campaignId, [...campaignIds])))
          .orderBy(asc(runs.versionId), asc(runs.id))
          .limit(sendPlanningRunLimit)
          .for("update", { of: runs, skipLocked: true });

      const plan = (at: Temporal.Instant) =>
        lockActiveAutomations().pipe(
          Effect.flatMap((campaignIds) =>
            campaignIds.length === 0
              ? Effect.succeed([])
              : selectReadyRuns(campaignIds)
          ),
          Effect.flatMap((ready) => planDeliverRuns(ready, at))
        );

      return {
        plan: (at) =>
          transaction(plan(at)).pipe(
            Effect.withSpan("AutomationSendPlanning.plan")
          ),
      };
    })
  );

  static Live = this.Default.pipe(Layer.provide(WorkspaceDatabase.Default));
}
