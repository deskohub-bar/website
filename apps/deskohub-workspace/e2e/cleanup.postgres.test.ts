import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  type DotyposReservationId,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Option } from "effect";
import type { StoredWorkspaceReservationDetails } from "@/features/reservation/persistence-contracts";
import {
  type ReservationFixtureInput,
  workspaceFixtures,
} from "@/shared/testing/workspace-fixtures.test-utils";
import { connectWorkspacePostgresTestDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { cleanupCheckoutFlowStates } from "./cleanup";
import { type DatasourceConfig, getDatasourceConfig } from "./config";
import { makeTestE2EEnvironment } from "./e2e-env.test-fixture";
import {
  readCheckoutRow,
  readCleanupCheckoutRows,
} from "./integrations/database";
import { E2EDatabase } from "./integrations/database.service";
import type { CheckoutData, CheckoutFlowState } from "./types";

const testDatabase = await connectWorkspacePostgresTestDatabase();
const datasourceConfig = getDatasourceConfig(makeTestE2EEnvironment());
const run = crypto.randomUUID();

// Each flow expects the identity its writer records, so cleanup must select
// the enriched rows by containment.
const families: readonly {
  readonly expected: CheckoutData["expectedReservationDetails"];
  readonly stored: StoredWorkspaceReservationDetails;
}[] = [
  {
    expected: { kind: "meeting-room", duration: { unit: "day", amount: 1 } },
    stored: { kind: "meeting-room", duration: { unit: "day", amount: 1 } },
  },
  {
    expected: { kind: "office", seats: 4, dayCount: 2 },
    stored: { kind: "office", seats: 4, dayCount: 2 },
  },
];

const customerId = (owner: string, kind: string): DotyposCustomerId =>
  DotyposCustomerIdSchema.make(`cleanup-${owner}-${kind}-${run}`);
const reservationId = (owner: string, kind: string): DotyposReservationId =>
  DotyposReservationIdSchema.make(`cleanup-${owner}-${kind}-${run}`);

describe.skipIf(!testDatabase)(
  "checkout cleanup on disposable Postgres",
  () => {
    if (!testDatabase) return;
    const { db } = testDatabase;

    test("cancels only this run's enriched fallback rows when another run's rows match", async () => {
      const startedAt = new Date(Date.now() - 1_000);
      const flowStates = families.map(
        ({ expected }): CheckoutFlowState => ({
          data: {
            checkoutUrl: "https://workspace.example.test/checkout",
            date: "2026-08-04",
            email: testEmailAddress(
              `delivered+cleanup-${expected.kind}-${run}`
            ),
            expectedReservationDetails: expected,
            locale: "en-US",
            name: `Workspace E2E cleanup ${expected.kind}`,
            orderIdHint: `cleanup-${expected.kind}`,
            phone: "+15555550100",
          },
          startedAt,
        })
      );
      const ownedEmails = new Map(
        flowStates.map(({ data }) => [
          reservationId("owned", data.expectedReservationDetails.kind),
          data.email,
        ])
      );

      await Effect.runPromise(
        workspaceFixtures(db).reservations(
          families.flatMap(({ stored }) =>
            ["owned", "foreign"].map(
              (owner): ReservationFixtureInput => ({
                stage: { reservation: "held", payment: "pending" },
                customer: customerId(owner, stored.kind),
                details: stored,
                overrides: {
                  dotyposReservationId: reservationId(owner, stored.kind),
                  reservationCreatedAt: Temporal.Now.instant(),
                },
              })
            )
          )
        )
      );

      const cancelDotyposReservation = mock(
        (_config: DatasourceConfig, _reservationId: DotyposReservationId) =>
          Effect.void
      );
      const cleanupError = await Effect.runPromise(
        cleanupCheckoutFlowStates(
          {
            datasourceConfig,
            flowStates,
            workflowError: undefined,
          },
          {
            cancelDotyposReservation,
            readCheckoutRow,
            readCleanupCheckoutRows,
            readCleanupCustomerIds: (_config, contacts) =>
              Effect.succeed(
                contacts.map(({ expectedReservationDetails }) =>
                  customerId("owned", expectedReservationDetails.kind)
                )
              ),
            // Each fixture's Dotypos customer and reservation share an ID.
            readDotyposReservationOwner: (_config, id) =>
              Effect.succeed(
                Option.some({
                  customerId: DotyposCustomerIdSchema.make(id),
                  email:
                    ownedEmails.get(id) ??
                    testEmailAddress(`delivered+other-run-${run}`),
                })
              ),
          }
        ).pipe(Effect.provideService(E2EDatabase, E2EDatabase.of({ db })))
      );

      expect(cleanupError).toBeUndefined();
      expect(
        cancelDotyposReservation.mock.calls.map(([, id]) => id).sort()
      ).toEqual(
        families.map(({ stored }) => reservationId("owned", stored.kind)).sort()
      );
    });
  }
);
