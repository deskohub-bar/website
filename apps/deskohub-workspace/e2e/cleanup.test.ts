import { expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposRejected,
  type DotyposReservationId,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { workspaceReservationIdSchema } from "@deskohub/workspace-domain/features/reservation/persistence-contracts";
import { Effect, Option } from "effect";
import { hostedCheckoutRow } from "./cases/checkout.test-utils";
import { unopenedE2EDatabase } from "./cases/e2e-fixtures.test-utils";
import {
  cleanupCheckoutFlowStates,
  cleanupOwnedCheckoutFlowStates,
} from "./cleanup";
import { type DatasourceConfig, getDatasourceConfig } from "./config";
import { makeTestE2EEnvironment } from "./e2e-env.test-fixture";
import { toWorkspaceE2EError, workspaceE2EError } from "./errors";
import type { E2EDatabase } from "./integrations/database.service";
import type { CheckoutData, CheckoutFlowState, CheckoutRow } from "./types";

const datasourceConfig = getDatasourceConfig(makeTestE2EEnvironment());
const dotyposCustomerId = DotyposCustomerIdSchema.make("dotypos-customer-1");
const otherRunEmail = testEmailAddress("delivered+other-run");

test("fallback cleanup cancels every matching reservation exactly once", async () => {
  const firstRow = checkoutRow("dotypos-reservation-1");
  const duplicateFirstRow = checkoutRow("dotypos-reservation-1");
  const secondRow = checkoutRow("dotypos-reservation-2");
  const readCleanupCheckoutRows = mock(() =>
    Effect.succeed([firstRow, duplicateFirstRow, secondRow])
  );
  const cancelDotyposReservation = mock(
    (_config: DatasourceConfig, _id: DotyposReservationId) => Effect.void
  );
  const data = checkoutData();
  const startedAt = new Date("2026-07-26T12:00:00.000Z");
  const flowStates: CheckoutFlowState[] = [
    { data, startedAt },
    { data, startedAt: new Date(startedAt.getTime() + 1_000) },
  ];

  const cleanupError = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates,
        workflowError: new Error("parallel sibling failed"),
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () => Effect.succeed(undefined),
        readCleanupCheckoutRows,
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: ownerForCheckoutData(data),
      }
    )
  );

  expect(cleanupError).toBeUndefined();
  expect(readCleanupCheckoutRows).toHaveBeenCalledTimes(1);
  expect(cancelDotyposReservation.mock.calls.map(([, id]) => id)).toEqual([
    DotyposReservationIdSchema.make("dotypos-reservation-1"),
    DotyposReservationIdSchema.make("dotypos-reservation-2"),
  ]);
});

test("overlaps cleanup lookups and independent cancellations", async () => {
  const lookupBarrier = makeBarrier(3);
  const cancellationBarrier = makeBarrier(3);
  const data = checkoutData();
  const startedAt = new Date("2026-07-26T12:00:00.000Z");
  const flowStates: CheckoutFlowState[] = [
    { data, orderId: workspaceReservationIdSchema.make("order-1"), startedAt },
    {
      data,
      orderId: workspaceReservationIdSchema.make("order-2"),
      startedAt: new Date(startedAt.getTime() + 1_000),
    },
  ];
  const cancelDotyposReservation = mock(() =>
    cancellationBarrier.wait(undefined)
  );

  const cleanupError = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates,
        workflowError: undefined,
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: (orderId) =>
          lookupBarrier.wait(
            checkoutRow(
              orderId === "order-1"
                ? "dotypos-reservation-1"
                : "dotypos-reservation-2",
              orderId
            )
          ),
        readCleanupCheckoutRows: () =>
          lookupBarrier.wait([checkoutRow("dotypos-reservation-3")]),
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: ownerForCheckoutData(data),
      }
    )
  );

  expect(cleanupError).toBeUndefined();
  expect(lookupBarrier.maximumActive()).toBe(3);
  expect(cancellationBarrier.maximumActive()).toBe(3);
  expect(cancelDotyposReservation).toHaveBeenCalledTimes(3);
});

test("fails closed on lookup errors before checkout cancellation", async () => {
  const cancelDotyposReservation = mock(() =>
    Effect.fail(workspaceE2EError("cancellation failed"))
  );
  const data = checkoutData();
  const startedAt = new Date("2026-07-26T12:00:00.000Z");
  const flowStates: CheckoutFlowState[] = [
    { checkoutRow: checkoutRow("dotypos-reservation-1"), data },
    { checkoutRow: checkoutRow("dotypos-reservation-2"), data },
    { data, orderId: workspaceReservationIdSchema.make("order-1"), startedAt },
    {
      data,
      orderId: workspaceReservationIdSchema.make("order-2"),
      startedAt: new Date(startedAt.getTime() + 1_000),
    },
  ];

  const cleanupError = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates,
        workflowError: new Error("workflow failed"),
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () =>
          Effect.fail(workspaceE2EError("row lookup failed")),
        readCleanupCheckoutRows: () =>
          Effect.fail(workspaceE2EError("fallback lookup failed")),
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: ownerForCheckoutData(data),
      }
    )
  );

  expect(cleanupError).toBeDefined();
  expect(cancelDotyposReservation).not.toHaveBeenCalled();
});

test("does not cancel order or fallback rows outside their journaled recipient", async () => {
  const cancelledReservationIds: string[] = [];
  const foreignRow = checkoutRow(
    "dotypos-reservation-foreign",
    "journaled-order"
  );
  const cancelDotyposReservation = mock(
    (_config: DatasourceConfig, id: DotyposReservationId) => {
      cancelledReservationIds.push(id);
      return Effect.void;
    }
  );
  const exactOrderState: CheckoutFlowState = {
    data: checkoutData(),
    orderId: workspaceReservationIdSchema.make("journaled-order"),
    startedAt: new Date("2026-07-26T12:00:00.000Z"),
  };

  const exactCleanupError = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [exactOrderState],
        workflowError: undefined,
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () => Effect.succeed(foreignRow),
        readCleanupCheckoutRows: () => Effect.succeed([]),
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: () =>
          Effect.succeed(
            Option.some({
              customerId: dotyposCustomerId,
              email: otherRunEmail,
            })
          ),
      }
    )
  );
  expect(exactCleanupError?.message).toContain("recipient ownership mismatch");

  const fallbackState: CheckoutFlowState = {
    data: { ...checkoutData(), locale: "cs-CZ" },
    startedAt: new Date("2026-07-26T12:00:00.000Z"),
  };
  const fallbackCleanupError = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [fallbackState],
        workflowError: undefined,
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () => Effect.succeed(undefined),
        readCleanupCheckoutRows: () => Effect.succeed([foreignRow]),
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: () =>
          Effect.succeed(
            Option.some({
              customerId: dotyposCustomerId,
              email: otherRunEmail,
            })
          ),
      }
    )
  );
  expect(fallbackCleanupError?.message).toContain(
    "recipient ownership mismatch"
  );

  expect(cancelledReservationIds).toEqual([]);
});

test("validates ownership of a captured reservation before checkout cancellation", async () => {
  const cancelDotyposReservation = mock(() => Effect.void);
  const state: CheckoutFlowState = {
    checkoutRow: checkoutRow("captured-reservation", "captured-order"),
    data: checkoutData(),
  };

  const cleanupError = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [state],
        workflowError: undefined,
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () => Effect.succeed(undefined),
        readCleanupCheckoutRows: () => Effect.succeed([]),
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: () =>
          Effect.succeed(
            Option.some({
              customerId: dotyposCustomerId,
              email: otherRunEmail,
            })
          ),
      }
    )
  );

  expect(cleanupError?.message).toContain("recipient ownership mismatch");
  expect(cancelDotyposReservation).not.toHaveBeenCalled();
});

test("treats only a missing reservation as already converged during cleanup", async () => {
  const state: CheckoutFlowState = {
    checkoutRow: checkoutRow("missing-reservation"),
    data: checkoutData(),
    startedAt: new Date("2026-08-04T12:00:00.000Z"),
  };
  const cancelDotyposReservation = mock(() => Effect.void);
  const waitForCancelledDotyposReservations = mock(() => Effect.void);
  const missingReservationResult = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [state],
        workflowError: undefined,
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () => Effect.succeed(undefined),
        readCleanupCheckoutRows: () => Effect.succeed([]),
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: () => Effect.succeed(Option.none()),
        waitForCancelledDotyposReservations,
      }
    )
  );

  expect(missingReservationResult).toBeUndefined();
  expect(cancelDotyposReservation).not.toHaveBeenCalled();
  expect(waitForCancelledDotyposReservations).toHaveBeenCalledWith(
    datasourceConfig,
    ["missing-reservation"],
    {
      endDate: new Date("2026-08-04T22:00:00.000Z"),
      startDate: new Date("2026-08-03T22:00:00.000Z"),
    }
  );

  const linkedCustomerMissing = new DotyposRejected({
    operation: "getReservation",
    request: "customer.get",
    reason: "not-found",
  });
  const customerNotFoundResult = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [state],
        workflowError: undefined,
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () => Effect.succeed(undefined),
        readCleanupCheckoutRows: () => Effect.succeed([]),
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: () =>
          Effect.fail(
            toWorkspaceE2EError(
              "read checkout cleanup reservation owner",
              linkedCustomerMissing
            )
          ),
        waitForCancelledDotyposReservations,
      }
    )
  );

  expect(customerNotFoundResult).toBeDefined();
  expect(cancelDotyposReservation).not.toHaveBeenCalled();
  expect(waitForCancelledDotyposReservations).toHaveBeenCalledTimes(1);
});

test("case-owned cleanup uses only captured IDs and exact-order lookups", async () => {
  const cancellationBarrier = makeBarrier(3);
  const capturedState: CheckoutFlowState = {
    checkoutRow: checkoutRow("dotypos-reservation-1"),
    data: checkoutData(),
    startedAt: new Date("2026-07-26T12:00:00.000Z"),
  };
  const exactOrderState: CheckoutFlowState = {
    data: checkoutData(),
    orderId: workspaceReservationIdSchema.make("order-2"),
    startedAt: new Date("2026-07-26T12:00:01.000Z"),
  };
  const secondCapturedState: CheckoutFlowState = {
    checkoutRow: checkoutRow("dotypos-reservation-3"),
    data: checkoutData(),
    startedAt: new Date("2026-07-26T12:00:02.000Z"),
  };
  const unresolvedInterruptedState: CheckoutFlowState = {
    data: checkoutData(),
    startedAt: new Date("2026-07-26T12:00:03.000Z"),
  };
  const readCheckoutRow = mock(() =>
    Effect.succeed(checkoutRow("dotypos-reservation-2"))
  );

  const cleanupError = await runCleanup(
    cleanupOwnedCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [
          capturedState,
          exactOrderState,
          secondCapturedState,
          unresolvedInterruptedState,
        ],
        workflowError: new Error("sibling interrupted"),
      },
      {
        cancelDotyposReservation: () => cancellationBarrier.wait(undefined),
        readCheckoutRow,
      }
    )
  );

  expect(cleanupError).toBeUndefined();
  expect(readCheckoutRow).toHaveBeenCalledTimes(1);
  expect(cancellationBarrier.maximumActive()).toBe(3);
  expect(capturedState.cleanupComplete).toBe(true);
  expect(capturedState.completedDotyposReservationId).toBe(
    DotyposReservationIdSchema.make("dotypos-reservation-1")
  );
  expect(exactOrderState.cleanupComplete).toBe(true);
  expect(secondCapturedState.cleanupComplete).toBe(true);
  expect(unresolvedInterruptedState.cleanupComplete).toBeUndefined();
});

test("does not cancel a journaled case reservation twice", async () => {
  const state: CheckoutFlowState = {
    cleanupComplete: true,
    completedDotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-reservation-1"
    ),
    data: checkoutData(),
    startedAt: new Date("2026-07-26T12:00:00.000Z"),
  };
  const cancelDotyposReservation = mock(() => Effect.void);
  const waitForCancelledDotyposReservations = mock(() => Effect.void);

  const cleanupError = await runCleanup(
    cleanupCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [state],
        workflowError: undefined,
      },
      {
        cancelDotyposReservation,
        readCheckoutRow: () => Effect.succeed(undefined),
        readCleanupCheckoutRows: () =>
          Effect.succeed([checkoutRow("dotypos-reservation-1")]),
        waitForCancelledDotyposReservations,
        readCleanupCustomerIds: () => Effect.succeed([]),
        readDotyposReservationOwner: ownerForCheckoutData(checkoutData()),
      }
    )
  );

  expect(cleanupError).toBeUndefined();
  expect(cancelDotyposReservation).not.toHaveBeenCalled();
  expect(waitForCancelledDotyposReservations).toHaveBeenCalledTimes(1);
});

test("case-owned cleanup leaves failed cancellations for suite reconciliation", async () => {
  const state: CheckoutFlowState = {
    checkoutRow: checkoutRow("dotypos-reservation-1"),
    data: checkoutData(),
  };

  const cleanupError = await runCleanup(
    cleanupOwnedCheckoutFlowStates(
      {
        datasourceConfig,
        flowStates: [state],
        workflowError: undefined,
      },
      {
        cancelDotyposReservation: () =>
          Effect.fail(workspaceE2EError("cancellation failed")),
        readCheckoutRow: () => Effect.succeed(undefined),
      }
    )
  );

  expect(cleanupError).toBeDefined();
  expect(state.cleanupComplete).toBeUndefined();
});

const runCleanup = <A>(effect: Effect.Effect<A, never, E2EDatabase>) =>
  Effect.runPromise(effect.pipe(Effect.provide(unopenedE2EDatabase)));

const checkoutData = (): CheckoutData => ({
  checkoutUrl: "https://workspace.example.test/checkout",
  date: "2026-08-04",
  email: testEmailAddress("delivered+synthetic-checkout"),
  expectedReservationDetails: {
    kind: "cowork",
    entryTier: "basic",
    coffee: false,
  },
  locale: "en-US",
  name: "Workspace E2E checkout cleanup",
  orderIdHint: "cleanup-checkout",
  phone: "+15555550100",
});

const checkoutRow = (
  dotyposReservationId: string,
  reservationId = "order-1"
): CheckoutRow =>
  hostedCheckoutRow("cleanup-attempt", "cleanup-provider-order", "nexi", {
    reservation_id: workspaceReservationIdSchema.make(reservationId),
    dotypos_customer_id: dotyposCustomerId,
    dotypos_reservation_id:
      DotyposReservationIdSchema.make(dotyposReservationId),
  });

const ownerForCheckoutData = (data: CheckoutData) => () =>
  Effect.succeed(
    Option.some({ customerId: dotyposCustomerId, email: data.email })
  );

const makeBarrier = (expectedParticipants: number) => {
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  let release: () => void = () => undefined;
  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    maximumActive: () => maximumActive,
    wait: <A>(value: A) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          if (started === expectedParticipants) release();
        }),
        () => Effect.promise(() => allStarted).pipe(Effect.as(value)),
        () =>
          Effect.sync(() => {
            active -= 1;
          })
      ),
  };
};
