import "@/shared/polyfills/temporal";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceTransaction,
} from "@/db/database.service";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";
import { ReferralInvitationLedger } from "./referral-invitation-ledger";

/** Runs a claim redemption in a transaction on the recording database. */
const redeemOnRecording = async (
  rows: readonly (readonly (readonly unknown[])[])[],
  redeem: () => Effect.Effect<void, unknown, WorkspaceTransaction>
) => {
  const recording = await makeRecordingWorkspaceDatabase();
  recording.setRows(rows.map((resultSet) => [...resultSet]));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { transaction } = yield* WorkspaceDatabase;
      return yield* transaction(redeem());
    }).pipe(Effect.provide(recording.layer), Effect.result)
  );
  return { result, statements: recording.statements };
};

const redeemedAt = Temporal.Instant.from("2026-01-01T00:00:00Z");

describe("ReferralInvitationLedger.redeem", () => {
  test("refuses to re-redeem a released invitation another booking consumed", async () => {
    for (const [previousPayment, otherActiveClaim] of [
      [[["reservation-2"]], []],
      [[], [["claim-2"]]],
    ] as const) {
      const { result, statements } = await redeemOnRecording(
        [
          [["customer-1", "customer-2", "promotion-1", "released"]],
          previousPayment,
          otherActiveClaim,
        ],
        () =>
          ReferralInvitationLedger.redeem({
            paymentAttemptId: paymentAttemptIdSchema.make("attempt-1"),
            workspaceReservationId:
              workspaceReservationIdSchema.make("reservation-1"),
            redeemedAt,
            readmitReleased: true,
          })
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { operation: "redeem", reason: "claim_conflict" },
      });
      expect(statements.some(({ sql }) => sql.startsWith("update"))).toBe(
        false
      );
    }
  });
});
