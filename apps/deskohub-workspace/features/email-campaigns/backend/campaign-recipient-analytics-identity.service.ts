import "server-only";

import type { PostHogDistinctId } from "@deskohub/analytics-posthog/identifiers";
import type { DotyposCustomerId } from "@deskohub/dotypos";
import { and, inArray, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { customerAccounts } from "@/db/schema/customer-accounts";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { getPostHogAccountDistinctId } from "@/features/account/posthog-account-distinct-id";
import {
  AnalyticsConsentLedger,
  type AnalyticsConsentUnavailable,
} from "@/features/legal/backend/analytics-consent-ledger";

/** Consent reads for one batch run this many at a time. */
const consentReadConcurrency = 10;

const noIdentities = () => new Map<DotyposCustomerId, PostHogDistinctId>();

type LinkedAccount = {
  readonly accountId: CustomerAccountId;
  readonly dotyposCustomerId: DotyposCustomerId;
};

type RecipientIdentities = ReadonlyMap<DotyposCustomerId, PostHogDistinctId>;

export interface ICampaignRecipientAnalyticsIdentity {
  /**
   * The PostHog person each recipient's campaign email may name, so its
   * engagement joins the account's events: the account linked to the
   * Dotypos customer, while its current analytics consent decision is a
   * grant. Recipients without one are absent: no account, no grant, or a
   * consent that couldn't be read. Never fails, since the email goes out
   * either way.
   */
  readonly forRecipients: (
    customerIds: readonly DotyposCustomerId[]
  ) => Effect.Effect<RecipientIdentities>;
  /** A pinned provider request must distinguish an unavailable read from a withdrawal. */
  readonly forGuardedRecipients: (
    customerIds: readonly DotyposCustomerId[]
  ) => Effect.Effect<
    RecipientIdentities,
    AnalyticsConsentUnavailable | DatabaseQueryError
  >;
}

/**
 * Whom a campaign email is about in PostHog, read at send time from the
 * account link and the analytics consent ledger: the same rule that links a
 * reservation's lifecycle events to its author.
 */
export class CampaignRecipientAnalyticsIdentity extends Context.Service<
  CampaignRecipientAnalyticsIdentity,
  ICampaignRecipientAnalyticsIdentity
>()("@deskohub-workspace/email-campaigns/CampaignRecipientAnalyticsIdentity") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const ledger = yield* AnalyticsConsentLedger;

      /** The live accounts linked to the customers. */
      const linkedAccounts = (customerIds: readonly DotyposCustomerId[]) =>
        db
          .select({
            accountId: customerAccounts.id,
            dotyposCustomerId: customerAccounts.dotyposCustomerId,
          })
          .from(customerAccounts)
          .where(
            and(
              inArray(customerAccounts.dotyposCustomerId, [...customerIds]),
              isNull(customerAccounts.deletedAt)
            )
          )
          .pipe(
            Effect.map((rows) =>
              rows.flatMap(
                ({ accountId, dotyposCustomerId }): LinkedAccount[] =>
                  dotyposCustomerId === null
                    ? []
                    : [{ accountId, dotyposCustomerId }]
              )
            )
          );

      const grants = (accountId: CustomerAccountId) =>
        ledger
          .currentDecision(accountId)
          .pipe(
            Effect.map(Option.exists(({ decision }) => decision === "grant"))
          );

      const identities = Effect.fn(
        "CampaignRecipientAnalyticsIdentity.identities"
      )(function* <Failure>(
        customerIds: readonly DotyposCustomerId[],
        allows: (
          accountId: CustomerAccountId
        ) => Effect.Effect<boolean, Failure>
      ) {
        if (customerIds.length === 0) return noIdentities();

        const accounts = yield* linkedAccounts(customerIds);
        const consented = yield* Effect.filter(
          accounts,
          ({ accountId }) => allows(accountId),
          {
            concurrency: consentReadConcurrency,
          }
        );
        return new Map(
          consented.map(({ accountId, dotyposCustomerId }) => [
            dotyposCustomerId,
            getPostHogAccountDistinctId(accountId),
          ])
        );
      });

      return {
        forGuardedRecipients: (customerIds) => identities(customerIds, grants),
        forRecipients: (customerIds) =>
          identities(customerIds, (accountId) =>
            grants(accountId).pipe(
              Effect.catchTag("AnalyticsConsentUnavailable", (cause) =>
                Effect.logWarning(
                  "Campaign recipient analytics consent unavailable",
                  {
                    errorType: cause._tag,
                  }
                ).pipe(Effect.as(false))
              )
            )
          ).pipe(
            Effect.catchTag("EffectDrizzleQueryError", (cause) =>
              Effect.logWarning(
                "Campaign recipient accounts could not be read",
                {
                  errorType: cause._tag,
                }
              ).pipe(Effect.as(noIdentities()))
            )
          ),
      } satisfies ICampaignRecipientAnalyticsIdentity;
    })
  );
}
