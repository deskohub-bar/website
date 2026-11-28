import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposRejected,
  DotyposReservationIdSchema,
  DotyposService,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Exit, Layer } from "effect";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  type EffectTrace,
  recordEffectTrace,
  startEffectTrace,
} from "@/shared/testing/effect-trace.test-utils";

mock.module("server-only", () => ({}));

const { DotyposHoldRelease } = await import("./dotypos-hold-release.service");
const { WorkspaceReservationRepository } = await import(
  "@/features/reservation/backend/workspace-reservation.repository"
);

const succeed =
  <const Value>(value: Value) =>
  () =>
    Effect.succeed(value);
const fail =
  <Error>(error: Error) =>
  () =>
    Effect.fail(error);

const statusReadUnavailable = new DotyposUnavailable({
  operation: "getReservationStatus",
  reason: "timeout",
});
const cancelUnavailable = new DotyposUnavailable({
  operation: "cancelReservation",
  reason: "timeout",
});

const release = async (input: {
  readonly liveStatus: "require_new" | "unchecked";
  readonly failureCode?:
    | "dotypos_cancel_failed"
    | "checkout_supersession_cancel_failed";
  readonly reservations?: Partial<
    typeof WorkspaceReservationRepository.Service
  >;
  readonly dotypos?: Partial<typeof DotyposService.Service>;
}) => {
  const trace: EffectTrace = startEffectTrace();
  const exit = await Effect.gen(function* () {
    const holdRelease = yield* DotyposHoldRelease;
    return yield* recordEffectTrace(
      trace,
      holdRelease.release({
        reservationId: workspaceReservationIdSchema.make("reservation-id"),
        claimedAt: Temporal.Instant.from("2026-07-01T08:00:00Z"),
        dotyposReservationId: DotyposReservationIdSchema.make(
          "dotypos-reservation-id"
        ),
        liveStatus: input.liveStatus,
        failureCode: input.failureCode ?? "dotypos_cancel_failed",
      })
    );
  }).pipe(
    Effect.provide(
      DotyposHoldRelease.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(
              WorkspaceReservationRepository,
              trace.recordCalls("reservations", {
                markCancellationFailed: succeed(undefined),
                ...input.reservations,
              })
            ),
            Layer.mock(
              DotyposService,
              trace.recordCalls("dotypos", {
                getReservationStatus: succeed("NEW"),
                cancelReservation: succeed(undefined),
                ...input.dotypos,
              })
            )
          )
        )
      )
    ),
    Effect.runPromise
  );
  return {
    outcome: Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause),
    trace: trace.entries,
  };
};

describe("DotyposHoldRelease.release", () => {
  test("cancels without reading the live status when the rule leaves it unchecked", async () => {
    const { outcome, trace } = await release({ liveStatus: "unchecked" });

    expect(outcome).toBe("cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
      ]
    `);
  });

  test("cancels a hold Dotypos still keeps NEW", async () => {
    const { outcome, trace } = await release({ liveStatus: "require_new" });

    expect(outcome).toBe("cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
      ]
    `);
  });

  test("takes a hold Dotypos already cancelled as released", async () => {
    const { outcome, trace } = await release({
      liveStatus: "require_new",
      dotypos: { getReservationStatus: succeed("CANCELLED") },
    });

    expect(outcome).toBe("already_cancelled");
    expect(trace).toMatchInlineSnapshot(`
      [
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
      ]
    `);
  });

  test("refuses and marks a hold whose live status isn't NEW", async () => {
    const { outcome, trace } = await release({
      liveStatus: "require_new",
      failureCode: "checkout_supersession_cancel_failed",
      dotypos: { getReservationStatus: succeed("CONFIRMED") },
    });

    expect(outcome).toEqual({ refused: "CONFIRMED" });
    expect(trace).toMatchInlineSnapshot(`
      [
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=reservation-id, claimedAt=<Instant>, failureCode=checkout_supersession_cancel_failed)",
      ]
    `);
  });

  test("marks the reservation and keeps the failure when the live status can't be read", async () => {
    const { outcome, trace } = await release({
      liveStatus: "require_new",
      failureCode: "checkout_supersession_cancel_failed",
      dotypos: { getReservationStatus: fail(statusReadUnavailable) },
    });

    expect(outcome).toBe(statusReadUnavailable);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=reservation-id, claimedAt=<Instant>, failureCode=checkout_supersession_cancel_failed)",
      ]
    `);
  });

  test("marks the reservation and keeps the failure when Dotypos can't cancel", async () => {
    const { outcome, trace } = await release({
      liveStatus: "unchecked",
      dotypos: { cancelReservation: fail(cancelUnavailable) },
    });

    expect(outcome).toBe(cancelUnavailable);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span dotyposHoldRelease.release",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=reservation-id, claimedAt=<Instant>, failureCode=dotypos_cancel_failed)",
      ]
    `);
  });

  test("keeps the Dotypos failure when the failure marker fails too", async () => {
    const { outcome, trace } = await release({
      liveStatus: "require_new",
      reservations: {
        markCancellationFailed: fail(
          new EffectDrizzleQueryError({
            query: "update reservations",
            params: [],
            cause: Cause.die(new Error("db down")),
          })
        ),
      },
      dotypos: {
        cancelReservation: fail(
          new DotyposRejected({
            operation: "cancelReservation",
            reason: "not-found",
          })
        ),
      },
    });

    expect(outcome).toBeInstanceOf(DotyposRejected);
    expect(trace).toMatchInlineSnapshot(`
      [
        "span dotyposHoldRelease.release",
        "call dotypos.getReservationStatus(dotypos-reservation-id)",
        "call dotypos.cancelReservation(dotypos-reservation-id)",
        "call reservations.markCancellationFailed(id=reservation-id, claimedAt=<Instant>, failureCode=dotypos_cancel_failed)",
        "Error Reservation cancellation failure marker failed (orderId=reservation-id, failureCode=dotypos_cancel_failed, cause=<EffectDrizzleQueryError>) {} in dotyposHoldRelease.release",
      ]
    `);
  });
});
