import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DotyposDiscountGroupIdSchema,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { workspaceReservationIdSchema } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import { instantStringSchema } from "@/shared/utils/temporal";
import {
  makeCoworkCheckoutData,
  makeTableCheckoutData,
} from "../checkout/data";
import { makeTestE2EEnvironment } from "../e2e-env.test-fixture";
import { makeE2ERunContext } from "../services/telemetry";
import type { CheckoutFlowState } from "../types";
import { resolveWorkspaceE2ERunContext } from "./run-context";
import {
  readWorkspaceE2ECaseJournals,
  readWorkspaceE2ERunPlan,
  type WorkspaceE2ERunPlan,
  writeWorkspaceE2ECaseJournal,
} from "./run-plan";

const caseId = "locale-switch";
const journalPath = resolve(
  import.meta.dir,
  "../../e2e-artifacts/checkout/cleanup-journals/locale-switch.json"
);

afterAll(async () => {
  await unlink(journalPath).catch(() => undefined);
});

test("persists exact cleanup completion for teardown reconciliation", async () => {
  const journalStartedAt = new Date("2026-08-12T10:00:00.000Z");
  const data = makeCoworkCheckoutData(
    "https://workspace.example.test",
    "2026-08-20"
  );
  const state: CheckoutFlowState = {
    cleanupComplete: true,
    completedDotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-reservation-1"
    ),
    data,
    orderId: workspaceReservationIdSchema.make("order-1"),
    startedAt: new Date("2026-08-12T10:00:01.000Z"),
  };

  await writeWorkspaceE2ECaseJournal(
    caseId,
    [state, { data }],
    journalStartedAt
  );
  const [restored, pending] = await readWorkspaceE2ECaseJournals([caseId]);

  expect(restored?.cleanupComplete).toBe(true);
  expect(restored?.completedDotyposReservationId).toBe(
    state.completedDotyposReservationId
  );
  expect(restored?.orderId).toBe(state.orderId);
  expect(restored?.startedAt).toEqual(state.startedAt);
  expect(pending?.cleanupComplete).toBe(false);
  expect(pending?.startedAt).toEqual(journalStartedAt);

  await writeFile(
    journalPath,
    JSON.stringify({
      caseId,
      checkoutStates: [{ data: { date: data.date } }],
      startedAt: journalStartedAt.toISOString(),
      version: 2,
    })
  );
  await expect(readWorkspaceE2ECaseJournals([caseId])).rejects.toThrow(
    "Invalid workspace E2E cleanup journal"
  );

  await writeFile(
    journalPath,
    JSON.stringify({
      caseId: "contact-form",
      checkoutStates: [{ data }],
      startedAt: journalStartedAt.toISOString(),
      version: 2,
    })
  );
  await expect(readWorkspaceE2ECaseJournals([caseId])).rejects.toThrow(
    "Invalid workspace E2E cleanup journal"
  );
});

test("reads a prepared run plan with no office and rejects malformed preparation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "workspace-e2e-run-plan-"));
  try {
    const path = resolve(directory, "plan.json");
    const basePreparation: NonNullable<WorkspaceE2ERunPlan["preparation"]> = {
      customerDiscountGroup: {
        basisPoints: 1000,
        id: DotyposDiscountGroupIdSchema.make("discount-group-1"),
      },
      discounts: {
        availableBasicDates: [],
        availablePlusDates: [],
        availableReservedDeskDates: [],
      },
      meetingRoom: { slots: [] },
      office: undefined,
      table: undefined,
    };
    const plan: WorkspaceE2ERunPlan = {
      preparation: basePreparation,
      runContext: makeE2ERunContext(makeTestE2EEnvironment()),
      version: 2,
    };
    const tableSlot = {
      date: "2026-08-20",
      endsAt: instantStringSchema.make("2026-08-20T10:00:00Z"),
      endTime: "12:00",
      seats: 4,
      startsAt: instantStringSchema.make("2026-08-20T08:00:00Z"),
      startTime: "10:00",
    };
    const planWithTable: WorkspaceE2ERunPlan = {
      ...plan,
      preparation: {
        ...basePreparation,
        table: {
          exclusiveForSingleTable: true,
          slot: tableSlot,
          urlStateSlot: {
            date: "2026-08-21",
            endsAt: instantStringSchema.make("2026-08-21T10:00:00Z"),
            endTime: "12:00",
            seats: 4,
            startsAt: instantStringSchema.make("2026-08-21T08:00:00Z"),
            startTime: "10:00",
          },
        },
      },
    };
    const planWithoutPreparation: WorkspaceE2ERunPlan = {
      runContext: plan.runContext,
      version: 2,
    };
    await writeFile(path, JSON.stringify(planWithoutPreparation));
    expect(await readWorkspaceE2ERunPlan(path)).toEqual(planWithoutPreparation);

    await writeFile(path, JSON.stringify(plan));
    expect(await readWorkspaceE2ERunPlan(path)).toEqual(plan);

    await writeFile(path, JSON.stringify(planWithTable));
    expect(await readWorkspaceE2ERunPlan(path)).toEqual(planWithTable);

    const tableData = makeTableCheckoutData(
      "https://workspace.example.test",
      tableSlot
    );
    await writeWorkspaceE2ECaseJournal(caseId, [{ data: tableData }]);
    const [restoredTable] = await readWorkspaceE2ECaseJournals([caseId]);
    expect(restoredTable?.data).toEqual(tableData);

    await writeFile(path, JSON.stringify({ ...plan, preparation: {} }));
    await expect(readWorkspaceE2ERunPlan(path)).rejects.toThrow(
      "Invalid workspace E2E run plan"
    );
    await writeFile(path, "malformed plan JSON");
    await expect(readWorkspaceE2ERunPlan(path)).rejects.toThrow(
      "Invalid workspace E2E run plan"
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("accepts the launcher's run context and rejects invalid allocation and run metadata", () => {
  const context = makeE2ERunContext(
    makeTestE2EEnvironment({
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "12345",
      TARGET_SHA: "a".repeat(40),
      WORKSPACE_E2E_PR_NUMBER: "100",
    })
  );
  const resolveContext = (serialized: string) =>
    resolveWorkspaceE2ERunContext(
      makeTestE2EEnvironment({ WORKSPACE_E2E_RUN_CONTEXT: serialized })
    );

  expect(resolveContext(JSON.stringify(context))).toEqual(context);
  for (const serialized of [
    "malformed context JSON",
    JSON.stringify({ ...context, githubRunAttempt: 0 }),
    JSON.stringify({ ...context, prNumber: -1 }),
    JSON.stringify({ ...context, targetSha: "invalid" }),
    JSON.stringify({
      ...context,
      allocation: {
        ...context.allocation,
        shardIndex: context.allocation.shardCount,
      },
    }),
  ]) {
    expect(() => resolveContext(serialized)).toThrow(
      "Invalid workspace E2E run context"
    );
  }
});
