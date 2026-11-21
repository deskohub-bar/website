import { runPassPurchaseReconciliation } from "@/features/passes/backend/pass-purchase-reconciliation";
import { defineWorkspaceCron } from "@/shared/backend/service-route";

export const maxDuration = 300;

export const GET = defineWorkspaceCron({
  operation: "passPurchaseReconciliationCron",
  failureMessage: "Pass purchase reconciliation failed",
  input: () => ({ now: Temporal.Now.instant(), limit: 15 }),
  run: runPassPurchaseReconciliation,
});
