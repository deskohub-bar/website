import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { resolveWorkspaceE2ESessionSigningSecret } from "../account/seeded-session";
import { makeWorkspaceE2EAdministrationIdentities } from "../administrators/identities";
import { getConfig } from "../config";
import { resolveWorkspaceE2ERunContext } from "../playwright-checkout/run-context";
import { assertPreviewPaymentProvider } from "../preview-readiness";
import {
  instantNavigationAdministratorJournalOwner,
  instantNavigationAdministratorLabel,
  instantNavigationAdministratorSkipReason,
  instantNavigationAdministratorTest as test,
  writeInstantNavigationAdministratorRunId,
} from "./administrator-session";

// Skipped before the administrator runtime fixture reads the environment.
test.skip(
  instantNavigationAdministratorSkipReason !== undefined,
  instantNavigationAdministratorSkipReason
);

// Seeds the one synthetic administrator the administration navigation tests
// sign in as. The run id is persisted before the journal, and the journal
// before the user row, so the teardown project can always reconcile it.
test("seed the instant navigation administrator", async ({
  administratorRuntime,
}) => {
  const { environment, runEffect } = administratorRuntime;
  const config = getConfig(environment);
  await runEffect(
    assertPreviewPaymentProvider(config).pipe(
      Effect.provide(FetchHttpClient.layer)
    )
  );
  const { runId } = resolveWorkspaceE2ERunContext(environment);
  await writeInstantNavigationAdministratorRunId(runId);
  const identities = makeWorkspaceE2EAdministrationIdentities<
    typeof instantNavigationAdministratorLabel
  >({
    journalDirectory:
      instantNavigationAdministratorJournalOwner.journalDirectory,
    ownerId: instantNavigationAdministratorJournalOwner.ownerId,
    runId,
    secret: resolveWorkspaceE2ESessionSigningSecret(environment),
  });
  await runEffect(
    identities.seed(instantNavigationAdministratorLabel, ["administrator"])
  );
});
