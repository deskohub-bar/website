import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type {
  PaymentAttemptState,
  PaymentState,
  ReferralInvitationClaimState,
  ReservationState,
} from "@/db/schema";
import { NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE } from "@/features/checkout/payment-fallback";
import {
  connectWorkspacePostgresTestDatabase,
  requireTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { admitReferralNexiPayment } from "./payment-lifecycle.test-utils";
import { PaymentTerminalTransitions } from "./payment-terminal-transitions";

const testDatabase = await connectWorkspacePostgresTestDatabase();

/** The module under test, built from nothing but the Workspace database. */
const runTransitions = <A, E>(
  operation: (
    transitions: typeof PaymentTerminalTransitions.Service
  ) => Effect.Effect<A, E>
) =>
  Effect.flatMap(PaymentTerminalTransitions, operation).pipe(
    Effect.provide(
      PaymentTerminalTransitions.Default.pipe(
        Layer.provide(requireTestDatabase(testDatabase).layer)
      )
    ),
    Effect.result,
    Effect.runPromise
  );

const readStates = async (paymentAttemptId: string) => {
  const { rows } = await requireTestDatabase(testDatabase).pool.query<{
    attempt_state: PaymentAttemptState;
    attempt_failure_code: string | null;
    payment_state: PaymentState;
    reservation_state: ReservationState;
    claim_state: ReferralInvitationClaimState;
    release_reason: string | null;
  }>(
    `select attempt.state as attempt_state,
            attempt.failure_code as attempt_failure_code,
            reservation.payment_state,
            reservation.reservation_state,
            claim.state as claim_state,
            claim.release_reason
       from payment_attempts attempt
       join workspace_reservations reservation
         on reservation.id = attempt.workspace_reservation_id
       join referral_invitation_claims claim
         on claim.payment_attempt_id = attempt.id
      where attempt.id = $1`,
    [paymentAttemptId]
  );
  return rows[0];
};

describe.skipIf(!testDatabase)(
  "Payment terminal transitions on disposable Postgres",
  () => {
    if (!testDatabase) return;
    test("ends an unpaid attempt and releases its claim with only the database provided", async () => {
      const { attempt, reservation } = await Effect.runPromise(
        admitReferralNexiPayment(testDatabase)
      );

      const result = await runTransitions((transitions) =>
        transitions.markTerminal({
          id: attempt.id,
          orderId: standaloneReservationOrderId(reservation.id),
          state: "failed",
          failureCode: "synthetic_terminal_failure",
          requireTransition: true,
        })
      );

      expect(result).toMatchObject({
        _tag: "Success",
        success: { changed: true, attempt: { id: attempt.id } },
      });
      expect(await readStates(attempt.id)).toEqual({
        attempt_state: "failed",
        attempt_failure_code: "synthetic_terminal_failure",
        payment_state: "failed",
        reservation_state: "held",
        claim_state: "released",
        release_reason: "synthetic_terminal_failure",
      });
    });

    test("an exact transition cannot mark an already-failed attempt as fallback eligible", async () => {
      const { attempt, reservation } = await Effect.runPromise(
        admitReferralNexiPayment(testDatabase)
      );
      const payment = {
        id: attempt.id,
        orderId: standaloneReservationOrderId(reservation.id),
        state: "failed",
      } as const;
      await runTransitions((transitions) =>
        transitions.markTerminal({
          ...payment,
          failureCode: "nexi_provider_failure",
        })
      );
      const marked = await runTransitions((transitions) =>
        transitions.markTerminal({
          ...payment,
          failureCode: NEXI_FALLBACK_ELIGIBLE_FAILURE_CODE,
          fromAttemptStates: ["pending"],
          requireTransition: true,
        })
      );

      expect(marked).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "PaymentLifecycleStateError" },
      });
      expect(await readStates(attempt.id)).toMatchObject({
        attempt_failure_code: "nexi_provider_failure",
        release_reason: "nexi_provider_failure",
      });
    });

    test("repeats the same terminal state unchanged and refuses another one", async () => {
      const { attempt, reservation } = await Effect.runPromise(
        admitReferralNexiPayment(testDatabase)
      );
      const markTerminal = (state: "cancelled" | "expired") =>
        runTransitions((transitions) =>
          transitions.markTerminal({
            id: attempt.id,
            orderId: standaloneReservationOrderId(reservation.id),
            state,
            failureCode: "synthetic_terminal_cancellation",
          })
        );

      await markTerminal("cancelled");
      const repeated = await markTerminal("cancelled");
      const other = await markTerminal("expired");

      expect(repeated).toMatchObject({
        _tag: "Success",
        success: { changed: false },
      });
      expect(other).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "PaymentLifecycleStateError",
          operation: "PaymentLifecycleRepository.markTerminal",
        },
      });
      expect((await readStates(attempt.id))?.attempt_state).toBe("cancelled");
    });
  }
);
