import { describe, expect, test } from "bun:test";
import type { Customer } from "@deskohub/dotypos/generated";
import { testEmailAddress } from "@deskohub/test-email";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { unopenedE2EDatabase } from "../cases/e2e-fixtures.test-utils";
import { getDatasourceConfig } from "../config";
import { makeTestE2EEnvironment } from "../e2e-env.test-fixture";
import { workspaceE2EError } from "../errors";
import { workspaceE2ERunIdSchema } from "../run-identifiers";
import { makeWorkspaceE2EAccountRecipientForRunId } from "./config";
import {
  emptyWorkspaceE2EAccountJournal,
  type WorkspaceE2EAccountJournal,
} from "./journal";
import {
  prepareWorkspaceE2EAccountLaneReconciliation,
  reconcileWorkspaceE2EAccountJournals,
  validateWorkspaceE2EAccountLaneJournalOwnership,
  type WorkspaceE2EAccountJournalOwner,
} from "./reconcile";
import { WorkspaceE2EAccountResourceService } from "./resources.service";
import { WorkspaceE2EAccountResourceServiceMock } from "./resources.service.mock";

const recipient = testEmailAddress("delivered+agent-run-agent");
const otherContact = testEmailAddress("someone.else");

test("rejects malformed journal IDs before changing resources", async () => {
  const datasourceConfig = getDatasourceConfig(
    makeTestE2EEnvironment({ DOTYPOS_API_URL: "http://127.0.0.1:1" })
  );
  const layer = WorkspaceE2EAccountResourceService.layer(datasourceConfig).pipe(
    Layer.provide(unopenedE2EDatabase)
  );
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const resources = yield* WorkspaceE2EAccountResourceService;
      yield* resources.removeRows({
        syntheticDotyposCustomerIds: [" customer-sentinel"],
        syntheticDotyposReservationIds: ["reservation-sentinel"],
      });
    }).pipe(Effect.provide(layer))
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.squash(exit.cause);
    expect(failure).toMatchObject({
      _tag: "WorkspaceE2EError",
      operation: "read synthetic account journal IDs",
    });
    expect(JSON.stringify(failure)).not.toContain("customer-sentinel");
    expect(JSON.stringify(failure)).not.toContain("reservation-sentinel");
  }
});

const journal: WorkspaceE2EAccountJournal = {
  ...emptyWorkspaceE2EAccountJournal("agent-run"),
  dotyposCustomerIds: ["seeded-customer", "other-contact"],
  dotyposReservationIds: ["own-hold", "other-contact-hold"],
};

const owners = {
  authUserOwners: new Map<string, string | null | undefined>(),
  customerOwners: new Map([
    ["seeded-customer", recipient],
    ["other-contact", otherContact],
  ]),
  journal,
  recipientEmails: new Set([recipient]),
  reservationOwners: new Map([
    ["own-hold", recipient],
    ["other-contact-hold", otherContact],
  ]),
};

const evidence = (
  reservations: { owned?: string[]; settled?: string[] },
  customers: { owned?: string[]; settled?: string[] } = {}
) => ({
  dotyposCustomerIds: {
    ownedIds: new Set(customers.owned),
    settledIds: new Set(customers.settled),
  },
  dotyposReservationIds: {
    ownedIds: new Set(reservations.owned),
    settledIds: new Set(reservations.settled),
  },
});

describe("validateWorkspaceE2EAccountLaneJournalOwnership", () => {
  test("refuses another contact's resources without evidence", () => {
    expect(() =>
      validateWorkspaceE2EAccountLaneJournalOwnership(owners)
    ).toThrow("ownership mismatch");
  });

  test("keeps another contact's resources the owner proves it created", () => {
    expect(
      validateWorkspaceE2EAccountLaneJournalOwnership({
        ...owners,
        evidence: evidence(
          { owned: ["other-contact-hold"] },
          { owned: ["other-contact"] }
        ),
      })
    ).toMatchObject({
      dotyposCustomerIds: ["seeded-customer", "other-contact"],
      dotyposReservationIds: ["own-hold", "other-contact-hold"],
    });
  });

  test("drops settled resources it can no longer prove, without touching them", () => {
    expect(
      validateWorkspaceE2EAccountLaneJournalOwnership({
        ...owners,
        evidence: evidence(
          { settled: ["other-contact-hold"] },
          { settled: ["other-contact"] }
        ),
      })
    ).toMatchObject({
      dotyposCustomerIds: ["seeded-customer"],
      dotyposReservationIds: ["own-hold"],
    });
  });

  test("still refuses an unproven resource when another one is proven", () => {
    expect(() =>
      validateWorkspaceE2EAccountLaneJournalOwnership({
        ...owners,
        evidence: evidence({ owned: ["other-contact-hold"] }),
      })
    ).toThrow("ownership mismatch");
  });
});

/*
 * A run's account booked a hold for another contact, whose profile Dotypos
 * created during the run. Only the reservation row the account authored
 * proves the run owns both, as `proveAgentEvalRunOwnership` reads it.
 */
const runId = workspaceE2ERunIdSchema.make("agent-run");
const accountId = "run-account";
const runRecipient = makeWorkspaceE2EAccountRecipientForRunId(runId, "agent");

type ReconciliationStep = "cancel" | "expire" | "remove rows";

const makeWorld = (unrelatedHold = false) => {
  const reservations = new Map<
    string,
    { email: string; status: "CONFIRMED" | "CANCELLED" }
  >([
    ["own-hold", { email: runRecipient, status: "CONFIRMED" }],
    ["other-contact-hold", { email: otherContact, status: "CONFIRMED" }],
  ]);
  if (unrelatedHold) {
    reservations.set("unrelated-hold", {
      email: otherContact,
      status: "CONFIRMED",
    });
  }
  const customers = new Map([
    ["seeded-customer", { email: runRecipient, expired: false }],
    ["other-contact", { email: otherContact, expired: false }],
  ]);
  /* workspace_reservations rows the run's account authored, by hold. */
  const rows = new Map([
    ["own-hold", "seeded-customer"],
    ["other-contact-hold", "other-contact"],
  ]);
  const authUsers = new Map([[accountId, runRecipient]]);
  let journal: WorkspaceE2EAccountJournal = {
    ...emptyWorkspaceE2EAccountJournal(runId),
    authUserIds: [accountId],
    dotyposCustomerIds: ["seeded-customer", "other-contact"],
    dotyposReservationIds: [
      "own-hold",
      "other-contact-hold",
      ...(unrelatedHold ? ["unrelated-hold"] : []),
    ],
  };
  const cancelled: string[] = [];

  const owner: WorkspaceE2EAccountJournalOwner = {
    ownerId: runId,
    proveOwnership: (_config, journaled) =>
      Effect.sync(() => {
        const ownedReservationIds = new Set(rows.keys());
        const ownedCustomerIds = new Set(rows.values());
        return {
          dotyposCustomerIds: {
            ownedIds: ownedCustomerIds,
            settledIds: new Set(
              journaled.dotyposCustomerIds.filter(
                (id) => !ownedCustomerIds.has(id) && customers.get(id)?.expired
              )
            ),
          },
          dotyposReservationIds: {
            ownedIds: ownedReservationIds,
            settledIds: new Set(
              journaled.dotyposReservationIds.filter(
                (id) =>
                  !ownedReservationIds.has(id) &&
                  reservations.get(id)?.status === "CANCELLED"
              )
            ),
          },
        };
      }),
    recipientLabels: ["agent"],
  };

  const resources = (failing?: ReconciliationStep) => {
    const fail = (step: ReconciliationStep) =>
      Effect.fail(workspaceE2EError(`synthetic ${step} failure`));
    return WorkspaceE2EAccountResourceServiceMock({
      cancelReservations: (ids) =>
        failing === "cancel"
          ? fail("cancel")
          : Effect.sync(() => {
              for (const id of ids) {
                const reservation = reservations.get(id);
                if (reservation) reservation.status = "CANCELLED";
                cancelled.push(id);
              }
            }),
      expireProfile: (id) =>
        failing === "expire"
          ? fail("expire")
          : Effect.sync(() => {
              const customer = customers.get(id);
              if (customer) customer.expired = true;
            }),
      readAuthUserEmail: (id) => Effect.succeed(authUsers.get(id)),
      readCustomerProfile: (id) =>
        Effect.succeed(
          Option.some<Customer>({
            _cloudId: "synthetic-cloud",
            deleted: false,
            display: true,
            email: customers.get(id)?.email,
            expireDate: customers.get(id)?.expired
              ? new Date(0).toISOString()
              : undefined,
            flags: "",
            id,
            points: null,
          })
        ),
      readJournal: () => Effect.sync(() => journal),
      readReservationOwner: (id) =>
        Effect.succeed(Option.some(reservations.get(id)?.email ?? null)),
      removeAuthUser: (id) => Effect.sync(() => void authUsers.delete(id)),
      removeRows: ({ syntheticDotyposReservationIds }) =>
        failing === "remove rows"
          ? fail("remove rows")
          : Effect.sync(() => {
              for (const id of syntheticDotyposReservationIds) rows.delete(id);
            }),
      writeJournal: (completed) =>
        Effect.sync(() => {
          journal = completed;
        }),
    });
  };

  /* One suite-cleanup pass: prepare the journal, then reconcile it. */
  const reconcile = (failing?: ReconciliationStep) =>
    Effect.runPromiseExit(
      prepareWorkspaceE2EAccountLaneReconciliation(
        getDatasourceConfig(makeTestE2EEnvironment()),
        runId,
        owner
      ).pipe(
        Effect.flatMap((prepared) =>
          reconcileWorkspaceE2EAccountJournals(prepared ? [prepared] : [])
        ),
        Effect.provide(Layer.merge(resources(failing), unopenedE2EDatabase))
      )
    );

  return {
    cancelled,
    customers,
    journal: () => journal,
    reconcile,
    reservations,
    rows,
  };
};

describe("reconcileWorkspaceE2EAccountJournals", () => {
  for (const failing of ["cancel", "expire", "remove rows"] as const) {
    test(`retries another contact's resources after a failed ${failing} step`, async () => {
      const world = makeWorld();

      expect(Exit.isFailure(await world.reconcile(failing))).toBe(true);
      expect(world.journal().completed).toBe(false);

      const retry = await world.reconcile();
      expect(Exit.isFailure(retry) ? String(retry.cause) : "reconciled").toBe(
        "reconciled"
      );
      expect(world.reservations.get("other-contact-hold")?.status).toBe(
        "CANCELLED"
      );
      expect(world.reservations.get("own-hold")?.status).toBe("CANCELLED");
      expect(world.customers.get("other-contact")?.expired).toBe(true);
      expect(world.customers.get("seeded-customer")?.expired).toBe(true);
      expect([...world.rows.keys()]).toEqual([]);
      expect(world.journal().completed).toBe(true);

      expect(Exit.isSuccess(await world.reconcile())).toBe(true);
    });
  }

  test("keeps the authorship rows while a provider step fails", async () => {
    const world = makeWorld();

    await world.reconcile("cancel");

    expect([...world.rows.keys()]).toEqual(["own-hold", "other-contact-hold"]);
  });

  test("still refuses an unrelated journaled hold, before and after a failed pass", async () => {
    const world = makeWorld(true);

    const first = await world.reconcile();
    expect(String(Exit.isFailure(first) && first.cause)).toContain(
      "ownership validation failed"
    );

    world.rows.delete("other-contact-hold");
    const repeat = await world.reconcile();
    expect(String(Exit.isFailure(repeat) && repeat.cause)).toContain(
      "ownership validation failed"
    );
    expect(world.cancelled).toEqual([]);
    expect(world.reservations.get("unrelated-hold")?.status).toBe("CONFIRMED");
  });
});
