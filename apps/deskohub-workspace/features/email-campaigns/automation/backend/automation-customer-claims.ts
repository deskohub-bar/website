import "server-only";

import type { DotyposCustomerId } from "@deskohub/dotypos";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { Effect } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import {
  emailCampaignAutomationCustomerClaims as customerClaims,
  emailCampaignAutomationRuns as runs,
} from "@/db/schema";
import type { CampaignId } from "../../campaign-identifiers";
import type { AutomationRunOutcome } from "../automation-states";

/**
 * Run endings that prove the run never mailed the customer, so they give
 * up its claim. `skipped` covers every skip before the provider request,
 * a marketing consent withdrawn by then included. A `withdrawn` run never reached the provider: delivery
 * withdraws a pass reminder only when its first request is refused before
 * admission (a replay or an admitted attempt ends `unconfirmed`), and
 * every other withdrawal comes before the send.
 */
const customerClaimReleasingOutcomes = [
  "skipped",
  "failed",
  "withdrawn",
] as const satisfies readonly AutomationRunOutcome[];

export const releasesCustomerClaim = (outcome: AutomationRunOutcome) =>
  customerClaimReleasingOutcomes.some((released) => released === outcome);

/**
 * The customers among `customers` the campaign already sent its one
 * automated email, for a once-per-customer send: a run of the campaign
 * holds their claim, or a run of any version reached its send and didn't
 * end proving it never mailed them. The second covers runs of a version
 * without the policy, which take no claim, and runs from before claims
 * existed.
 */
export const customersAlreadySentOnce = (
  db: Pick<WorkspaceDatabaseClient, "select">,
  campaignId: CampaignId,
  customers: readonly DotyposCustomerId[]
) =>
  Effect.all(
    [
      db
        .select({ dotyposCustomerId: customerClaims.dotyposCustomerId })
        .from(customerClaims)
        .where(
          and(
            eq(customerClaims.campaignId, campaignId),
            inArray(customerClaims.dotyposCustomerId, [...customers])
          )
        ),
      db
        .select({ dotyposCustomerId: runs.dotyposCustomerId })
        .from(runs)
        .where(
          and(
            eq(runs.campaignId, campaignId),
            inArray(runs.dotyposCustomerId, [...customers]),
            isNotNull(runs.sendId),
            or(
              isNull(runs.outcome),
              notInArray(runs.outcome, [...customerClaimReleasingOutcomes])
            )
          )
        ),
    ],
    { concurrency: 1 }
  ).pipe(
    Effect.map(
      ([claimed, sent]): ReadonlySet<DotyposCustomerId> =>
        new Set([...claimed, ...sent].map((row) => row.dotyposCustomerId))
    )
  );
