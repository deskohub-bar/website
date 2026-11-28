import { Effect, Exit, Scope } from "effect";
import { runUntracedE2EEffect } from "../effect-edge";
import { isWorkspaceE2ECaseSelected } from "../flows";
import {
  isWorkspaceE2ENightlyCaseId,
  isWorkspaceE2EOfficeCaseId,
  isWorkspaceE2ETableCaseId,
  type WorkspaceE2ECaseId,
} from "./case-catalog";
import { readWorkspaceE2ERunPlan } from "./run-plan";
import { runtimeTest } from "./runtime-fixtures";

type WorkspaceE2EFixtures = {
  readonly testScope: Scope.Scope;
};

type WorkspaceE2EWorkerFixtures = {
  readonly runPlan: Awaited<ReturnType<typeof readWorkspaceE2ERunPlan>>;
};

export const test = runtimeTest.extend<
  WorkspaceE2EFixtures,
  WorkspaceE2EWorkerFixtures
>({
  // The test's Scope owns its browser session: the case's one session opens
  // there on first use, inside the case runner, so a browser that fails to
  // open is still the case's failure; closing the Scope closes the session,
  // its release bounded by one browser action.
  testScope: async ({ browserName: _browserName }, use) => {
    const scope = Scope.makeUnsafe("parallel");
    try {
      await use(scope);
    } finally {
      await runUntracedE2EEffect(Scope.close(scope, Exit.void));
    }
  },
  runPlan: [
    async ({ browserName: _browserName }, use) =>
      use(await readWorkspaceE2ERunPlan()),
    { scope: "worker" },
  ],
});

/**
 * Binds a planned case to state only its own test may create, such as seeded
 * run-scoped synthetic identities, before the case runner admits it.
 */
export type WorkspaceE2ECaseBinder = (input: {
  /** The worker browser; the case's own session context is its only one. */
  readonly browser: import("@playwright/test").Browser;
  readonly environment: import("../e2e-env").WorkspaceE2EEnvironment;
  readonly runId: import("../run-identifiers").WorkspaceE2ERunId;
  readonly testCase: import("../types").WorkspaceE2ECase;
}) => Promise<import("../types").WorkspaceE2ECase>;

export const registerWorkspaceE2ECases = (
  caseIds: readonly WorkspaceE2ECaseId[],
  options: { readonly bindCase?: WorkspaceE2ECaseBinder } = {}
) => {
  for (const caseId of caseIds) {
    test(
      caseId,
      async ({ browser, environment, runEffect, runPlan, testScope }) => {
        const { nightlyCasesEnabled, workspaceE2EFlowSelection } = await import(
          "../e2e-env"
        );
        test.skip(
          !isWorkspaceE2ECaseSelected(
            caseId,
            workspaceE2EFlowSelection(environment)
          ),
          "Excluded by WORKSPACE_E2E_FLOWS"
        );
        test.skip(
          isWorkspaceE2ENightlyCaseId(caseId) &&
            !nightlyCasesEnabled(environment),
          "Runs only in the nightly Workspace E2E"
        );
        const { makePublicSiteWorkspaceE2ECases, makeWorkspaceE2ECases } =
          await import("../cases");
        const { getConfig, getDatasourceConfig } = await import("../config");
        const { workspaceDir } = await import("../runtime");
        const { runWorkspaceE2ECase } = await import("../suite");
        const { writeWorkspaceE2ECaseJournal } = await import("./run-plan");
        const config = getConfig(environment);
        const datasourceConfig = getDatasourceConfig(environment);

        const planned = await runEffect(
          Effect.gen(function* () {
            const { preparation } = runPlan;
            const cases = preparation
              ? yield* makeWorkspaceE2ECases({
                  allocation: runPlan.runContext.allocation,
                  config,
                  datasourceConfig,
                  flowStates: [],
                  preparation,
                  traceConstruction: false,
                })
              : makePublicSiteWorkspaceE2ECases(config);
            return cases.find((testCase) => testCase.id === caseId);
          })
        );
        if (!planned) {
          test.skip(
            isWorkspaceE2EOfficeCaseId(caseId),
            "The office page is disabled in this preview"
          );
          test.skip(
            isWorkspaceE2ETableCaseId(caseId),
            "The Team Table page is disabled in this preview"
          );
          throw new Error(`Workspace E2E case ${caseId} was not constructed`);
        }
        const selected = options.bindCase
          ? await options.bindCase({
              browser,
              environment,
              runId: runPlan.runContext.runId,
              testCase: planned,
            })
          : planned;

        if (selected.id !== caseId) {
          throw new Error(
            `Workspace E2E case ${caseId} changed its journal owner`
          );
        }
        const journalStartedAt = new Date();
        await writeWorkspaceE2ECaseJournal(
          caseId,
          selected.checkoutStates,
          journalStartedAt
        );
        try {
          await runEffect(
            runWorkspaceE2ECase({
              artifactRoot: `${workspaceDir}/e2e-artifacts/checkout/cases`,
              browser,
              datasourceConfig,
              sessionPrefix: `workspace-checkout-e2e-${runPlan.runContext.runId}`,
              testCase: selected,
              timeouts: config.timeouts,
            }).pipe(Scope.provide(testScope))
          );
        } finally {
          await writeWorkspaceE2ECaseJournal(
            caseId,
            selected.checkoutStates,
            journalStartedAt
          );
        }
      }
    );
  }
};
