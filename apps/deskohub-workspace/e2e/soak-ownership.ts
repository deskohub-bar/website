import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isTestEmailAddress } from "@deskohub/test-email";
import { Result, Schema } from "effect";
import { workspaceE2EAccountCaseIds } from "./account/catalog";
import { makeWorkspaceE2EAccountRecipientForRunId } from "./account/config";
import { workspaceE2EAccountLaneId } from "./account/journal";
import type { E2EEnvironment } from "./e2e-env";
import { nightlyCasesEnabled, workspaceE2EFlowSelection } from "./e2e-env";
import {
  isWorkspaceE2ECaseSelected,
  isWorkspaceE2EFlowSelected,
} from "./flows";
import {
  isWorkspaceE2ECaseId,
  isWorkspaceE2ENightlyCaseId,
  isWorkspaceE2EOfficeCaseId,
  isWorkspaceE2ETableCaseId,
  workspaceE2ECaseIds,
} from "./playwright-checkout/case-catalog";
import { workspaceE2ECheckoutJournalOwners } from "./playwright-checkout/journal-owners";
import { readWorkspaceE2ERunPlan } from "./playwright-checkout/run-plan";
import {
  type ReservationIntent,
  readReservationJournal,
  reservationIntentSchema,
} from "./reservation-journal";
import { workspaceDir } from "./runtime";
import type { E2ERunContext } from "./services/telemetry";

export type RunOwnership = {
  readonly intents: readonly ReservationIntent[];
  readonly emails: readonly string[];
  readonly customerIds: readonly string[];
  readonly accountIds: readonly string[];
  readonly journalCount: number;
};

/** Uses the same case and identity owner registries as suite cleanup. */
export const readRunOwnership = async (
  environment: E2EEnvironment,
  artifactRoot = resolve(workspaceDir, "e2e-artifacts/checkout")
): Promise<RunOwnership> => {
  const plan = await readWorkspaceE2ERunPlan(
    resolve(artifactRoot, "run-plan.json")
  );
  const context = plan.runContext;
  const flowSelection = workspaceE2EFlowSelection(environment);
  const caseExpected = (caseId: string) =>
    isWorkspaceE2ECaseId(caseId) &&
    isWorkspaceE2ECaseSelected(caseId, flowSelection) &&
    (plan.preparation?.office !== undefined ||
      !isWorkspaceE2EOfficeCaseId(caseId)) &&
    (plan.preparation?.table !== undefined ||
      !isWorkspaceE2ETableCaseId(caseId)) &&
    (nightlyCasesEnabled(environment) || !isWorkspaceE2ENightlyCaseId(caseId));
  if (
    context.runId !==
      `${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}` ||
    context.targetSha !== environment.TARGET_SHA ||
    context.githubRunId !== environment.GITHUB_RUN_ID ||
    context.githubRunAttempt !== environment.GITHUB_RUN_ATTEMPT
  )
    throw new Error("Unknown run ownership identity");
  const root = resolve(artifactRoot, "cleanup-journals");
  const accounts = resolve(artifactRoot, "account-journals");
  await assertKnownFiles(root, workspaceE2ECaseIds);
  await assertKnownFiles(
    accounts,
    workspaceE2ECheckoutJournalOwners.map(({ ownerId }) => ownerId)
  );
  const intents: ReservationIntent[] = [];
  const emails = new Set<string>();
  const customerIds = new Set<string>();
  const accountIds = new Set<string>();
  let journalCount = 0;
  for (const caseId of workspaceE2ECaseIds) {
    const journal = await readReservationJournal(
      resolve(root, `${caseId}.json`)
    );
    if (!journal) {
      if (caseExpected(caseId))
        throw new Error("Missing case ownership journal");
      continue;
    }
    if (journal.caseId !== caseId || !Array.isArray(journal.checkoutStates)) {
      throw new Error("Invalid case ownership journal");
    }
    for (const state of journal.checkoutStates) {
      if (
        !isRecord(state) ||
        !isRecord(state.data) ||
        typeof state.data.email !== "string"
      ) {
        throw new Error("Unknown checkout owner");
      }
      emails.add(state.data.email);
    }
    intents.push(
      ...parseReservationIntents(journal.reservationIntents, context, [caseId])
    );
    journalCount++;
  }
  for (const owner of workspaceE2ECheckoutJournalOwners) {
    const caseId = owner.caseId ?? owner.ownerId;
    for (const label of owner.recipientLabels) {
      emails.add(
        makeWorkspaceE2EAccountRecipientForRunId(context.runId, label)
      );
    }
    const journal = await readReservationJournal(
      resolve(accounts, `${owner.ownerId}.json`)
    );
    if (!journal) {
      if (
        (caseId === workspaceE2EAccountLaneId &&
          isWorkspaceE2EFlowSelected("account", flowSelection)) ||
        caseExpected(caseId)
      )
        throw new Error("Missing account ownership journal");
      continue;
    }
    if (journal.laneId !== owner.ownerId)
      throw new Error("Unknown account owner");
    addIds(customerIds, journal.dotyposCustomerIds);
    addIds(accountIds, journal.authUserIds);
    // Account reservations are created by its catalog; referral fixtures use
    // their checkout case's journal, which is persisted before case admission.
    intents.push(
      ...parseReservationIntents(
        journal.reservationIntents,
        context,
        workspaceE2EAccountCaseIds
      )
    );
    journalCount++;
  }
  if (
    intents.length === 0 ||
    new Set(intents.map(({ id }) => id)).size !== intents.length
  )
    throw new Error("Missing or duplicate creation intent coverage");
  for (const intent of intents) {
    if ("customerId" in intent.owner) customerIds.add(intent.owner.customerId);
    else emails.add(intent.owner.email);
  }
  if ([...emails].some((email) => !isTestEmailAddress(email)))
    throw new Error("Unknown synthetic owner coverage");
  return {
    intents,
    emails: [...emails].toSorted(),
    customerIds: [...customerIds].toSorted(),
    accountIds: [...accountIds].toSorted(),
    journalCount,
  };
};

const decodeReservationIntent = Schema.decodeUnknownResult(
  reservationIntentSchema
);

export const parseReservationIntents = (
  value: unknown,
  context: Pick<E2ERunContext, "runId">,
  cases: readonly string[]
): readonly ReservationIntent[] => {
  if (!Array.isArray(value))
    throw new Error("Missing reservation intent coverage");
  return value.map((entry: unknown) => {
    const decoded = decodeReservationIntent(entry);
    if (Result.isFailure(decoded)) {
      throw new Error("Unknown reservation intent coverage");
    }
    const intent = decoded.success;
    if (
      !cases.includes(intent.caseId) ||
      intent.runId !== context.runId ||
      !(Date.parse(intent.endDate) > Date.parse(intent.startDate))
    )
      throw new Error("Unknown reservation intent coverage");
    return intent;
  });
};

const assertKnownFiles = async (path: string, owners: readonly string[]) => {
  const files = await readdir(path);
  const expected = new Set(owners.map((owner) => `${owner}.json`));
  if (files.some((file) => !expected.has(file)))
    throw new Error("Unenumerated reservation journal owner");
};

const addIds = (target: Set<string>, value: unknown) => {
  if (
    !Array.isArray(value) ||
    !value.every((id): id is string => typeof id === "string" && id.length > 0)
  ) {
    throw new Error("Unknown journal owner identity");
  }
  for (const id of value) target.add(id);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
