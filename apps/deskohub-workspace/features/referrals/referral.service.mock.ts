import { DotyposService } from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { CustomerAccountLinkRepository } from "@/features/account/backend/customer-account-link.repository";
import { CustomerAccountSections } from "@/features/account/backend/customer-account-sections";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { makeTestDatabaseClient } from "@/shared/testing/workspace-recording-database.test-utils";
import { type IReferralService, ReferralService } from "./referral.service";
import { ReferralReleaseGate } from "./referral-release-gate";

export const ReferralServiceMock = (
  overrides: Partial<IReferralService> = {}
) =>
  Layer.succeed(ReferralService, {
    getAccountSummary: () => Effect.die("getAccountSummary was not mocked"),
    acceptReferral: () => Effect.die("acceptReferral was not mocked"),
    lookupCodeKind: () => Effect.die("lookupCodeKind was not mocked"),
    findAvailableCode: () => Effect.die("findAvailableCode was not mocked"),
    evaluateCheckoutReferral: () =>
      Effect.die("evaluateCheckoutReferral was not mocked"),
    hasSettledReferral: () => Effect.die("hasSettledReferral was not mocked"),
    resolveInvitationCandidate: () => Effect.undefined,
    resolveReferrerCandidate: () => Effect.undefined,
    ...overrides,
  });

/** A Workspace database whose every statement and transaction dies. */
const unavailableReferralDatabase = Layer.effect(
  WorkspaceDatabase,
  makeTestDatabaseClient(
    Effect.die(new Error("Referral data is unavailable in this test."))
  ).pipe(Effect.map((db) => WorkspaceDatabase.make(db)))
);

/**
 * The real ReferralService over empty data mocks: any read of recorded
 * referrals dies. It takes the referral decision from the caller's
 * `ReferralReleaseGate`.
 */
export const ReferralServiceWithoutData = ReferralService.Default.pipe(
  Layer.provide(
    Layer.mergeAll(
      unavailableReferralDatabase,
      Layer.mock(WorkspaceDatabaseAdvisoryLock, {}),
      Layer.mock(DotyposService, {}),
      Layer.mock(CustomerAuthentication, {}),
      Layer.mock(CustomerAccountLinkRepository, {}),
      Layer.mock(CustomerAccountSections, {})
    )
  )
);

/** The real ReferralService while the `referrals` flag withholds the program. */
export const WithheldReferralService = ReferralServiceWithoutData.pipe(
  Layer.provide(ReferralReleaseGate.fromDecision(false))
);
