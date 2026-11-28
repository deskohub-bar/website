import {
  DotyposBranchIdSchema,
  DotyposCloudIdSchema,
  type DotyposCustomer,
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  type DotyposOperation,
  type DotyposReadFailure,
  type DotyposReservation,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { EmailConfigTag, EmailServiceTag } from "@deskohub/email";
import { makeEmailProviderFake } from "@deskohub/email/testing";
import { testEmailAddress } from "@deskohub/test-email";
import { emailAutomationTickMinutes } from "@deskohub/workspace-admin-api";
import { eq, sql } from "drizzle-orm";
import {
  Array as Arr,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
  Struct,
} from "effect";
import { TestClock } from "effect/testing";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import {
  customerEvents,
  customerMarketingConsents,
  workspaceReservations,
} from "@/db/schema";
import {
  type CustomerAccountId,
  customerAccountIdSchema,
} from "@/features/account/customer-account";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { PassReminderReads } from "@/features/passes/backend/pass-reminder-reads.service";
import { ReservationActivitySweep } from "@/features/reservation/backend/reservation-activity-sweep.service";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import type {
  CustomerEventId,
  CustomerEventKind,
} from "@/shared/backend/customer-events/customer-event";
import { CustomerEventReconciler } from "@/shared/backend/customer-events/customer-event-reconciler";
import {
  type CancellationEventRetraction,
  retractCancellationEvent,
} from "@/shared/backend/customer-events/customer-event-retraction";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import type {
  WorkspacePostgresSuiteDatabase,
  WorkspacePostgresTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { AudienceFactsService } from "../../backend/audience-facts.service";
import { CampaignCandidateRepository } from "../../backend/campaign-candidate.repository";
import { campaignDeliveryTestLayer } from "../../backend/campaign-delivery.test-utils";
import { CampaignEmailConfig } from "../../backend/campaign-email.config";
import { CampaignRecipientService } from "../../backend/campaign-recipient.service";
import type { CampaignId } from "../../campaign-identifiers";
import type { AutomationWorkUnitId } from "../automation-identifiers";
import {
  automationTickAtOrAfter,
  automationTickAtOrBefore,
} from "../automation-ticks";
import {
  type AutomationWorkUnitKind,
  automationWorkUnitKinds,
} from "../automation-work-units";
import { AutomationConditionEvaluation } from "./automation-condition-evaluation.service";
import { AutomationConditionPlanning } from "./automation-condition-planning.service";
import { automationEngineTestLayer } from "./automation-engine.test-utils";
import { AutomationEngineHealth } from "./automation-engine-health.service";
import { AutomationEvaluationFacts } from "./automation-evaluation-facts.service";
import { AutomationIntakePlanning } from "./automation-intake-planning.service";
import { AutomationLifecycle } from "./automation-lifecycle.service";
import { automationLifecycleTestKit } from "./automation-lifecycle.test-utils";
import { AutomationPlanner } from "./automation-planner.service";
import { makePreviewUnitHandler } from "./automation-preview-unit";
import { AutomationRunSettlement } from "./automation-run-settlement.service";
import { AutomationSchedulePlanning } from "./automation-schedule-planning.service";
import { AutomationSendPlanning } from "./automation-send-planning.service";
import { AutomationSweepPlanning } from "./automation-sweep-planning.service";
import { AutomationTimerPlanning } from "./automation-timer-planning.service";
import {
  type AutomationUnitOutcome,
  AutomationUnitProcessor,
} from "./automation-unit-processor.service";
import {
  type AutomationUnitQueueFake,
  type AutomationUnitQueueFakeMessage,
  drainAutomationUnitQueue,
  makeAutomationUnitQueueFake,
} from "./automation-unit-queue.test-utils";
import { makeConditionHandler } from "./condition";
import { makeDeliverHandler } from "./deliver";
import { makeFireChunkHandler } from "./fire-chunk";
import { makeIntakeHandler } from "./intake";
import { makePassReminderIntakeHandler } from "./pass-reminder-intake";
import { makeSweepPageHandler } from "./sweep-page";

// ---------------------------------------------------------------------------
// Dotypos

const engineDotyposMethods = [
  "getCustomersByIds",
  "getReservationsByIds",
  "listReservationsPage",
  "listReservations",
  "listActiveReservationsPage",
] as const satisfies readonly DotyposOperation[];

/** The Dotypos read operations the engine uses. */
export type EngineDotyposMethod = (typeof engineDotyposMethods)[number];

/** A failure a Dotypos read can return: a network error or an HTTP status. */
export type EngineDotyposFailure = DotyposReadFailure;

/**
 * Runs before each Dotypos request and may delay it (an `Effect.sleep` on
 * the `TestClock`) or fail it, as latency, a 429 or an outage would.
 */
export type EngineDotyposRequestHook = (request: {
  readonly method: EngineDotyposMethod;
  readonly ids?: readonly string[];
}) => Effect.Effect<void, EngineDotyposFailure>;

const isEngineDotyposMethod = (
  operation: DotyposOperation
): operation is EngineDotyposMethod =>
  engineDotyposMethods.some((method) => method === operation);

/**
 * A Dotypos fake whose customers and visits tests change between
 * invocations, as Dotypos would. It answers the engine's reads from the
 * in-memory Dotypos, counts every request by method (one per ID batch), and a
 * test can gate, delay or fail requests.
 */
export const makeEngineDotypos = () => {
  const calls = {
    getCustomersByIds: 0,
    getReservationsByIds: 0,
    listReservationsPage: 0,
    listReservations: 0,
    listActiveReservationsPage: 0,
  } satisfies Record<EngineDotyposMethod, number>;
  let hook: EngineDotyposRequestHook | undefined;
  const gates: Array<{
    readonly method: EngineDotyposMethod | "any";
    readonly reached: () => void;
    readonly released: Promise<void>;
  }> = [];

  const request = (
    method: EngineDotyposMethod,
    ids?: readonly string[]
  ): Effect.Effect<void, EngineDotyposFailure> =>
    Effect.suspend(() => {
      calls[method] += 1;
      const index = gates.findIndex(
        (gate) => gate.method === method || gate.method === "any"
      );
      const gate = index === -1 ? undefined : gates.splice(index, 1)[0];
      gate?.reached();
      return (
        gate === undefined ? Effect.void : Effect.promise(() => gate.released)
      ).pipe(Effect.andThen(hook?.({ method, ids }) ?? Effect.void));
    });

  const dotypos = makeInMemoryDotypos(
    {},
    {
      onRequest: ({ operation, ids }) =>
        isEngineDotyposMethod(operation)
          ? request(operation, ids)
          : Effect.void,
    }
  );
  const { customers, reservations } = dotypos;
  const layer = DotyposServiceMock(
    Struct.pick(dotypos.service, engineDotyposMethods)
  );

  return {
    layer,
    /** Profiles by id; tests may fill or change it directly. */
    customers,
    /** Visits by Dotypos reservation id; tests may fill or change it directly. */
    reservations,
    /** Requests made so far, by method, including failed ones. */
    calls,
    resetCalls: () => {
      for (const method of engineDotyposMethods) calls[method] = 0;
    },
    setCustomers: (next: readonly DotyposCustomer[]) => {
      customers.clear();
      for (const customer of next) customers.set(customer.id, customer);
    },
    setReservations: (next: readonly DotyposReservation[]) => {
      reservations.clear();
      for (const reservation of next) {
        reservations.set(reservation.id, reservation);
      }
    },
    /** Sets (or with `undefined` clears) the hook every request runs first. */
    onRequest: (next: EngineDotyposRequestHook | undefined) => {
      hook = next;
    },
    /**
     * Fails every request matching `method` (default: all) with `failure`
     * until `restore` is called.
     */
    fail: (
      failure: EngineDotyposFailure,
      method: EngineDotyposMethod | "any" = "any"
    ) => {
      hook = (call) =>
        method === "any" || call.method === method
          ? Effect.fail(failure)
          : Effect.void;
      return () => {
        hook = undefined;
      };
    },
    /** Fails the next `count` requests matching `method`, then answers again. */
    failNext: (
      count: number,
      failure: EngineDotyposFailure,
      method: EngineDotyposMethod | "any" = "any"
    ) => {
      let remaining = count;
      hook = (call) => {
        if (remaining <= 0 || (method !== "any" && call.method !== method)) {
          return Effect.void;
        }
        remaining -= 1;
        return Effect.fail(failure);
      };
    },
    /**
     * Holds the next request matching `method` until `release` is called;
     * `reached` resolves when it arrives.
     */
    gate: (method: EngineDotyposMethod | "any" = "any") => {
      let reached: () => void = () => {};
      let release: () => void = () => {};
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.push({ method, reached, released });
      return { reached: arrived, release };
    },
  };
};
export type EngineDotypos = ReturnType<typeof makeEngineDotypos>;

/** A Dotypos profile reachable at a test-domain address. */
export const engineProfile = (
  id: DotyposCustomerId,
  overrides: Partial<DotyposCustomer> = {}
): DotyposCustomer => ({
  id,
  _cloudId: DotyposCloudIdSchema.make("automation-engine-cloud"),
  firstName: "Test",
  email: testEmailAddress(id.slice(-48)),
  points: "0",
  flags: "0",
  display: true,
  deleted: false,
  tags: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Resend

/** The shared provider exercised through the same delivery service as production. */
export const makeResendFake = () => {
  const fake = makeEmailProviderFake();
  return {
    ...fake,
    layer: EmailServiceTag.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          fake.layer,
          Layer.succeed(EmailConfigTag, {
            defaultFrom: { email: testEmailAddress("automation-sender") },
          })
        )
      )
    ),
  };
};
export type ResendFake = ReturnType<typeof makeResendFake>;

// ---------------------------------------------------------------------------
// The engine layer

/** The planner steps after the reaper that a test can switch on. */
export type AutomationScenarioPlanningStep =
  | "sweep"
  | "intake"
  | "timers"
  | "conditions"
  | "sends"
  | "schedules";

const allPlanningSteps: readonly AutomationScenarioPlanningStep[] = [
  "sweep",
  "intake",
  "timers",
  "conditions",
  "sends",
  "schedules",
];

const unitHandlerMakers = {
  "sweep-page": makeSweepPageHandler,
  preview: makePreviewUnitHandler,
  intake: makeIntakeHandler,
  "pass-reminder-intake": makePassReminderIntakeHandler,
  "fire-chunk": makeFireChunkHandler,
  condition: makeConditionHandler,
  deliver: makeDeliverHandler,
};

const idleReconciler = Layer.succeed(CustomerEventReconciler, {
  reconcile: Effect.succeed({ booked: 0, cancelled: 0, accountCreated: 0 }),
});

/**
 * The real engine over the suite's own database: the planner, the
 * processor and the handlers of `kinds` (default: every kind, as
 * `AutomationUnitHandlers.Live`) with the planner steps in `planning`
 * (default: all) live, plus `AutomationLifecycle` and
 * `AutomationEngineHealth`. Dotypos, Resend and the queue are the given
 * fakes. The sweep's capture reconcile is idle unless `reconcile` is set,
 * since it reads every Workspace reservation.
 */
export const automationScenarioLayer = async (input: {
  readonly database: WorkspacePostgresSuiteDatabase;
  readonly dotypos: Pick<EngineDotypos, "layer">;
  readonly queue: AutomationUnitQueueFake;
  readonly resend?: ResendFake;
  readonly kinds?: ReadonlyArray<AutomationWorkUnitKind>;
  readonly planning?: ReadonlyArray<AutomationScenarioPlanningStep>;
  readonly limits?: { readonly total: number; readonly deliver: number };
  readonly reconcile?: boolean;
  readonly deploymentEnvironment?: "production" | "development";
  readonly passReminderReads?: Layer.Layer<PassReminderReads>;
  readonly passReminderGate?: Layer.Layer<CoworkPassesReleaseGate>;
}) => {
  const database = input.database.layer;
  const base = Layer.merge(database, input.dotypos.layer);
  const resend = input.resend ?? makeResendFake();
  const candidates = CampaignCandidateRepository.Default.pipe(
    Layer.provide(database)
  );
  const audienceFacts = AudienceFactsService.Default.pipe(
    Layer.provide(Layer.merge(candidates, input.dotypos.layer))
  );
  const recipients = CampaignRecipientService.Default.pipe(
    Layer.provide(Layer.merge(candidates, audienceFacts))
  );
  const conditionEvaluation = AutomationConditionEvaluation.Default.pipe(
    Layer.provide(Layer.merge(candidates, audienceFacts))
  );
  const evaluationFacts = AutomationEvaluationFacts.Default.pipe(
    Layer.provide(base)
  );
  const emailConfig = Layer.succeed(CampaignEmailConfig, {
    deploymentEnvironment: input.deploymentEnvironment ?? "development",
    from: { email: testEmailAddress("campaigns") },
    replyTo: { email: testEmailAddress("hello") },
    adminInbox: testEmailAddress("admin"),
  });
  const delivery = campaignDeliveryTestLayer(
    Layer.mergeAll(input.dotypos.layer, resend.layer, emailConfig)
  ).pipe(Layer.provide(database));
  const dependencies = Layer.mergeAll(
    base,
    candidates,
    recipients,
    conditionEvaluation,
    evaluationFacts,
    delivery,
    emailConfig,
    input.passReminderGate ?? CoworkPassesReleaseGate.fromDecision(false),
    input.passReminderReads ??
      Layer.succeed(PassReminderReads, {
        listDue: () => Effect.succeed([]),
        readDue: () => Effect.succeed(Option.none()),
      }),
    AutomationRunSettlement.Default,
    ReservationActivitySweep.Default
  );
  const kinds = input.kinds ?? automationWorkUnitKinds;
  const handlers = await Effect.runPromise(
    Effect.all(kinds.map((kind) => unitHandlerMakers[kind])).pipe(
      Effect.provide(dependencies)
    )
  );
  const steps = new Set(input.planning ?? allPlanningSteps);
  const withFacts = Layer.merge(database, evaluationFacts);
  const engine = automationEngineTestLayer({
    database: input.database,
    queue: input.queue,
    handlers,
    ...(input.limits && { limits: input.limits }),
    ...(steps.has("sweep") && {
      sweepPlanning: AutomationSweepPlanning.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            database,
            ReservationActivitySweep.Default,
            input.reconcile
              ? CustomerEventReconciler.Default.pipe(Layer.provide(database))
              : idleReconciler
          )
        )
      ),
    }),
    ...(steps.has("intake") && {
      intakePlanning: AutomationIntakePlanning.Default.pipe(
        Layer.provide(withFacts)
      ),
    }),
    ...(steps.has("timers") && {
      timerPlanning: AutomationTimerPlanning.Default.pipe(
        Layer.provide(database)
      ),
    }),
    ...(steps.has("conditions") && {
      conditionPlanning: AutomationConditionPlanning.Default.pipe(
        Layer.provide(withFacts)
      ),
    }),
    ...(steps.has("sends") && {
      sendPlanning: AutomationSendPlanning.Default.pipe(
        Layer.provide(database)
      ),
    }),
    ...(steps.has("schedules") && {
      schedulePlanning: AutomationSchedulePlanning.Default.pipe(
        Layer.provide(withFacts)
      ),
    }),
  });
  return Layer.mergeAll(
    AutomationLifecycle.Default,
    AutomationEngineHealth.Default
  ).pipe(Layer.provideMerge(engine));
};

/**
 * The engine with the real intake and fire-chunk handlers and planner
 * steps 4 and 8 over the suite's own database and `dotypos`; every other
 * step is idle.
 */
export const entryEngineLayer = (input: {
  readonly database: WorkspacePostgresSuiteDatabase;
  readonly dotypos: Pick<EngineDotypos, "layer">;
  readonly queue: AutomationUnitQueueFake;
  readonly limits?: { readonly total: number; readonly deliver: number };
}) =>
  automationScenarioLayer({
    ...input,
    kinds: ["intake", "fire-chunk"],
    planning: ["intake", "schedules"],
  });

type AutomationScenarioLayer = Awaited<
  ReturnType<typeof automationScenarioLayer>
>;
/** The services a scenario's effects may use. */
export type AutomationScenarioServices = Layer.Success<AutomationScenarioLayer>;

/** Runs `effect` on the engine with the clock at `at`. */
export const runEngineAt = <A, E>(
  effect: Effect.Effect<A, E, AutomationScenarioServices>,
  layer: AutomationScenarioLayer,
  at: Temporal.Instant
) =>
  Effect.runPromise(
    TestClock.setTime(at.epochMilliseconds).pipe(
      Effect.andThen(effect),
      Effect.provide(Layer.merge(layer, TestClock.layer()))
    )
  );

/** One planner run, then every unit it enqueued, as the minute cron and queue would. */
export const planAndProcess = (queue: AutomationUnitQueueFake) =>
  Effect.flatMap(AutomationPlanner, (planner) => planner.plan).pipe(
    Effect.flatMap((summary) =>
      drainAutomationUnitQueue(queue).pipe(
        Effect.map((deliveries) => ({ summary, deliveries }))
      )
    )
  );

// ---------------------------------------------------------------------------
// Workspace and Dotypos fixtures

/**
 * Seeds the Workspace and Dotypos side of scenarios under one run prefix
 * and removes everything it created. Customers get a test-domain address
 * unless `email` says otherwise.
 */
export const makeEngineFixtures = (
  database: WorkspacePostgresTestDatabase,
  dotypos: Pick<EngineDotypos, "customers" | "reservations">,
  prefix: string
) => {
  const { db } = database;
  const created = {
    reservations: Arr.empty<WorkspaceReservationId>(),
    events: Arr.empty<CustomerEventId>(),
    consents: Arr.empty<DotyposCustomerId>(),
    accounts: Arr.empty<CustomerAccountId>(),
    campaigns: Arr.empty<string>(),
    passes: Arr.empty<string>(),
  };
  const dotyposReservationId = (id: WorkspaceReservationId) =>
    DotyposReservationIdSchema.make(`${id}-dotypos`);

  const customerId = (label: string) =>
    DotyposCustomerIdSchema.make(`${prefix}-${label}`);

  /** A customer Dotypos returns, with an active marketing consent. */
  const addCustomer = async (
    label: string,
    options: {
      readonly consent?: boolean;
      readonly email?: string;
      readonly profile?: Partial<DotyposCustomer>;
    } = {}
  ) => {
    const id = customerId(label);
    dotypos.customers.set(
      id,
      engineProfile(id, {
        ...(options.email !== undefined && { email: options.email }),
        ...options.profile,
      })
    );
    if (options.consent ?? true) {
      created.consents.push(id);
      await Effect.runPromise(
        db.insert(customerMarketingConsents).values({
          dotyposCustomerId: id,
          documentHash: "hash",
          locale: "cs-CZ",
          grantedAt: Temporal.Instant.from("2026-01-01T00:00:00Z"),
          withdrawnAt: null,
        })
      );
    }
    return id;
  };

  /** A Workspace-booked reservation with its visit in Dotypos. */
  const book = async (input: {
    readonly label: string;
    readonly customer: DotyposCustomerId;
    readonly startsAt: Temporal.Instant;
    readonly endsAt: Temporal.Instant;
    readonly reservedDesk?: boolean;
  }) => {
    const id = workspaceReservationIdSchema.make(`${prefix}-${input.label}`);
    created.reservations.push(id);
    const confirmedAt = input.startsAt.subtract({ hours: 48 });
    await Effect.runPromise(
      workspaceFixtures(db).reservation({
        stage: {
          reservation: "confirmed",
          payment: "paid",
          fulfillment: "fulfilled",
        },
        customer: input.customer,
        details: input.reservedDesk
          ? { kind: "cowork", entryTier: "reserved-desk", coffee: true }
          : { kind: "cowork", entryTier: "open-space", coffee: false },
        at: confirmedAt,
        locale: "cs-CZ",
        overrides: {
          id,
          dotyposReservationId: dotyposReservationId(id),
          createdAt: confirmedAt,
        },
      })
    );
    moveVisit(id, input);
    return id;
  };

  /** Changes a visit in Dotypos only, as a reschedule or cancellation there does. */
  const moveVisit = (
    id: WorkspaceReservationId,
    visit: {
      readonly startsAt: Temporal.Instant;
      readonly endsAt: Temporal.Instant;
      readonly customer?: DotyposCustomerId;
      readonly status?: "CONFIRMED" | "CANCELLED";
    }
  ) => {
    const reservationId = dotyposReservationId(id);
    const existing = dotypos.reservations.get(reservationId);
    const customer = visit.customer ?? existing?._customerId;
    const reservation = {
      id: reservationId,
      _branchId: DotyposBranchIdSchema.make("automation-entry-branch"),
      _cloudId: DotyposCloudIdSchema.make("automation-entry-cloud"),
      startDate: visit.startsAt.toString(),
      endDate: visit.endsAt.toString(),
      seats: "1",
      status: visit.status ?? "CONFIRMED",
    } satisfies DotyposReservation;
    dotypos.reservations.set(
      reservationId,
      customer === undefined
        ? reservation
        : { ...reservation, _customerId: customer }
    );
  };

  /** Cancels a visit in Dotypos only, keeping its times. */
  const cancelVisit = (id: WorkspaceReservationId) => {
    const existing = dotypos.reservations.get(dotyposReservationId(id));
    if (existing === undefined) return;
    dotypos.reservations.set(dotyposReservationId(id), {
      ...existing,
      status: "CANCELLED",
    });
  };

  /** Removes a visit from Dotypos, as deleting it there does. */
  const deleteVisit = (id: WorkspaceReservationId) =>
    dotypos.reservations.delete(dotyposReservationId(id));

  /** Cancels a reservation in Workspace, as a customer's cancellation does. */
  const cancelInWorkspace = (
    id: WorkspaceReservationId,
    at: Temporal.Instant
  ) =>
    database.pool.query(
      "update workspace_reservations set reservation_cancelled_at = $2 where id = $1",
      [id, at.toString()]
    );

  /**
   * Restores a reservation Workspace cancelled at `cancelledAt`, as a
   * restore does: confirmed and no longer cancelled, with the undone
   * cancellation's event retracted in the same transaction.
   */
  const restoreReservation = (
    id: WorkspaceReservationId,
    cancelledAt: Temporal.Instant,
    at: Temporal.Instant
  ) =>
    Effect.flatMap(WorkspaceTransaction, ({ db }) =>
      db
        .update(workspaceReservations)
        .set({ reservationState: "confirmed", reservationCancelledAt: null })
        .where(eq(workspaceReservations.id, id))
    ).pipe(
      Effect.andThen(
        retractCancellationEvent({ reservationId: id, cancelledAt, at })
      )
    );

  const restoreInWorkspace = (
    id: WorkspaceReservationId,
    cancelledAt: Temporal.Instant,
    at: Temporal.Instant
  ) =>
    Effect.runPromise(
      Effect.flatMap(WorkspaceDatabase, ({ transaction }) =>
        transaction(restoreReservation(id, cancelledAt, at))
      ).pipe(Effect.provide(database.layer))
    );

  /**
   * Runs `restoreInWorkspace` up to its commit and holds the transaction
   * open, with the reservation row locked, until `commit`, which resolves
   * once it committed. `pid` identifies the restore for `pg_blocking_pids`.
   */
  const holdRestoreInWorkspace = async (
    id: WorkspaceReservationId,
    cancelledAt: Temporal.Instant,
    at: Temporal.Instant
  ) => {
    const committing = Deferred.makeUnsafe<void>();
    const opened = Deferred.makeUnsafe<
      {
        readonly pid: number;
        readonly retraction: CancellationEventRetraction;
      },
      unknown
    >();
    const restore = Effect.runFork(
      Effect.flatMap(WorkspaceDatabase, ({ transaction }) =>
        transaction(
          Effect.gen(function* () {
            const { db } = yield* WorkspaceTransaction;
            const [held] = yield* db
              .select({ pid: sql<number>`pg_backend_pid()` })
              .from(workspaceReservations)
              .where(eq(workspaceReservations.id, id));
            const backend = yield* Effect.fromNullishOr(held);
            const retraction = yield* restoreReservation(id, cancelledAt, at);
            yield* Deferred.succeed(opened, { pid: backend.pid, retraction });
            yield* Deferred.await(committing);
          })
        )
      ).pipe(
        Effect.onError((cause) => Deferred.failCause(opened, cause)),
        Effect.provide(database.layer)
      )
    );
    const { pid, retraction } = await Effect.runPromise(Deferred.await(opened));
    return {
      pid,
      retraction,
      commit: () =>
        Effect.runPromise(
          Deferred.succeed(committing, undefined).pipe(
            Effect.andThen(Fiber.join(restore))
          )
        ),
    };
  };

  const recordEvent = async (input: {
    readonly kind: CustomerEventKind;
    readonly customer: DotyposCustomerId;
    readonly occurredAt: Temporal.Instant;
    readonly reservationId?: WorkspaceReservationId;
    readonly recordedAt?: Temporal.Instant;
    /** An account-created event's account is an existing customer's (D37). */
    readonly legacy?: boolean;
  }) => {
    let customerAccountId: CustomerAccountId | null = null;
    if (input.kind === "account-created") {
      customerAccountId = customerAccountIdSchema.make(
        `${prefix}-account-${created.accounts.length}`
      );
      created.accounts.push(customerAccountId);
      await Effect.runPromise(
        workspaceFixtures(db).customerAccount({
          id: customerAccountId,
          legacy: input.legacy ?? false,
        })
      );
    }
    const [event] = await Effect.runPromise(
      db
        .insert(customerEvents)
        .values({
          kind: input.kind,
          occurredAt: input.occurredAt,
          recordedAt: input.recordedAt ?? input.occurredAt,
          dotyposCustomerId: input.customer,
          workspaceReservationId: input.reservationId ?? null,
          customerAccountId,
        })
        .returning({ id: customerEvents.id })
    );
    const { id } = requireValue(event, "inserted customer event");
    created.events.push(id);
    return id;
  };

  /**
   * A one-off campaign email to `customer`, dispatched at `at`: `sent` (by
   * default) in a batch requested then, or still `pending`, in a requested
   * batch unless `batched` is false. The campaign is Sent once its email
   * was, Sending while it's pending.
   */
  const deliverOneOffCampaign = async (input: {
    readonly customer: DotyposCustomerId;
    readonly at: Temporal.Instant;
    readonly purpose?: "marketing" | "operational";
    readonly status?: "sent" | "pending" | "failed";
    readonly batched?: boolean;
    readonly campaignStatus?: "sent" | "sending" | "failed";
  }) => {
    const { pool } = database;
    const id = `${prefix}-one-off-${created.campaigns.length}`;
    created.campaigns.push(id);
    const status = input.status ?? "sent";
    await pool.query(
      `insert into email_campaigns (id, title, purpose, template_key, status)
       values ($1, 'One-off', $2, 'workspace', $3)`,
      [
        id,
        input.purpose ?? "marketing",
        input.campaignStatus ?? (status === "pending" ? "sending" : "sent"),
      ]
    );
    await pool.query(
      `insert into email_campaign_sends (id, campaign_id, audience_filter, content_hash, created_at)
       values ($1, $1, '{"_tag":"Group","operator":"and","filters":[]}', 'hash', $2)`,
      [id, input.at.toString()]
    );
    await pool.query(
      `insert into email_campaign_recipients (send_id, dotypos_customer_id, locale, status, status_updated_at)
       values ($1, $2, 'cs-CZ', $3, $4)`,
      [id, input.customer, status, input.at.toString()]
    );
    if (input.batched ?? true) {
      await pool.query(
        `insert into email_campaign_delivery_batches (send_id, delivery_attempt, batch_index, dotypos_customer_ids, payload_hash, status, requested_at, settled_at)
         values ($1, 1, 0, $2, 'hash', $3, $4, case when $3 = 'requested' then null else $4::timestamptz end)`,
        [
          id,
          [input.customer],
          status === "pending" ? "requested" : "accepted",
          input.at.toString(),
        ]
      );
    }
    return id;
  };

  /**
   * A complimentary pass held by `customer`'s account, linked to them (and
   * created) on first use, valid from `validFrom` until `validUntil`
   * (Prague dates). An Entry pack has 5 entries, all of them used when
   * `depleted`.
   */
  const holdPass = async (input: {
    readonly customer: DotyposCustomerId;
    readonly kind: "entry-pack" | "unlimited";
    readonly validFrom: string;
    readonly validUntil: string;
    readonly depleted?: boolean;
  }) => {
    const { pool } = database;
    const linked = await pool.query<{ id: CustomerAccountId }>(
      "select id from customer_accounts where dotypos_customer_id = $1",
      [input.customer]
    );
    const holder =
      linked.rows[0]?.id ??
      (await Effect.runPromise(
        workspaceFixtures(db).customerAccount({
          linkedCustomer: input.customer,
        })
      ));
    if (linked.rows.length === 0) created.accounts.push(holder);
    const passId = crypto.randomUUID();
    created.passes.push(passId);
    await pool.query(
      `insert into orders (id, kind, dotypos_customer_id, payment_state, fulfillment_state, fulfilled_at)
       values ($1, 'pass-purchase', $2, 'complimentary', 'fulfilled', now())`,
      [passId, input.customer]
    );
    await pool.query(
      `insert into pass_purchases (id, buyer_account_id, holder_account_id, product, tier,
         entry_count, unlimited_coffee, status, valid_from, valid_until, quote, locale, created_at)
       values ($1, $2, $2, $3, 'open-space',
         case when $3 = 'entry-pack' then 5 end,
         case when $3 = 'unlimited' then false end, 'active',
         $4, $5, '{}', 'en-US', now())`,
      [passId, holder, input.kind, input.validFrom, input.validUntil]
    );
    for (const day of input.depleted ? [0, 1, 2, 3, 4] : []) {
      const date = Temporal.PlainDate.from(input.validFrom).add({ days: day });
      const reservation = await Effect.runPromise(
        workspaceFixtures(db).reservation({
          customer: input.customer,
          stage: {
            reservation: "confirmed",
            payment: "paid",
            fulfillment: "fulfilled",
          },
          at: Temporal.Instant.from(`${date}T08:00:00Z`),
        })
      );
      created.reservations.push(reservation.id);
      await pool.query(
        "insert into pass_entry_claims (reservation_id, pass_id, date, status) values ($1, $2, $3, 'consumed')",
        [reservation.id, passId, date.toString()]
      );
    }
    return passId;
  };

  /** Makes `reservationId`'s active payment attempt `attempt`. */
  const settleReservation = async (
    reservationId: WorkspaceReservationId,
    attempt: {
      readonly id: string;
      readonly provider: "nexi" | "internal";
      readonly amountValue: number;
    }
  ) => {
    const { pool } = database;
    await pool.query(
      `insert into payment_attempts (id, order_id, workspace_reservation_id, provider,
         provider_order_id, state, amount_value, amount_exponent, currency)
       values ($1, $2, $2, $3, $4, 'paid', $5, 2, 'CZK')`,
      [
        attempt.id,
        reservationId,
        attempt.provider,
        attempt.provider === "nexi" ? `order-${attempt.id}` : null,
        attempt.amountValue,
      ]
    );
    await pool.query(
      "update workspace_reservations set active_payment_attempt_id = $2 where id = $1",
      [reservationId, attempt.id]
    );
  };

  /** Pays `reservationId` by its own order: a paid card attempt it keeps. */
  const payIndividually = (reservationId: WorkspaceReservationId) =>
    settleReservation(reservationId, {
      id: `${reservationId}-card`,
      provider: "nexi",
      amountValue: 29000,
    });

  /**
   * Funds `reservationId` from an Entry pack `customer` holds for its visit
   * date only: a consumed entry claim and the zero-amount internal attempt
   * that marks it paid.
   */
  const payFromEntryPack = async (input: {
    readonly reservationId: WorkspaceReservationId;
    readonly customer: DotyposCustomerId;
    readonly date: string;
  }) => {
    const passId = await holdPass({
      customer: input.customer,
      kind: "entry-pack",
      validFrom: input.date,
      validUntil: Temporal.PlainDate.from(input.date)
        .add({ days: 1 })
        .toString(),
    });
    await database.pool.query(
      "insert into pass_entry_claims (reservation_id, pass_id, date, status) values ($1, $2, $3, 'consumed')",
      [input.reservationId, passId, input.date]
    );
    await settleReservation(input.reservationId, {
      id: `${input.reservationId}-entry`,
      provider: "internal",
      amountValue: 0,
    });
  };

  const cleanup = async () => {
    const { pool } = database;
    await pool.query("delete from pass_entry_claims where pass_id = any($1)", [
      created.passes,
    ]);
    await pool.query("delete from pass_purchases where id = any($1)", [
      created.passes,
    ]);
    await pool.query("delete from orders where id = any($1)", [created.passes]);
    await pool.query(
      "delete from email_campaign_delivery_batches where send_id = any($1)",
      [created.campaigns]
    );
    await pool.query(
      "delete from email_campaign_recipients where send_id = any($1)",
      [created.campaigns]
    );
    await pool.query("delete from email_campaign_sends where id = any($1)", [
      created.campaigns,
    ]);
    await pool.query("delete from email_campaigns where id = any($1)", [
      created.campaigns,
    ]);
    // Events the sweep recorded for this prefix's reservations.
    const { rows } = await pool.query<{ id: CustomerEventId }>(
      "select id from customer_events where workspace_reservation_id = any($1) or dotypos_customer_id like $2",
      [created.reservations, `${prefix}-%`]
    );
    const events = [...new Set([...created.events, ...rows.map((r) => r.id)])];
    await pool.query(
      "delete from email_campaign_automation_work_units where kind = 'intake' and subject->'eventIds' ?| $1",
      [events]
    );
    await pool.query(
      "update email_campaign_automation_runs set trigger_event_id = null where trigger_event_id = any($1)",
      [events]
    );
    await pool.query("delete from customer_events where id = any($1)", [
      events,
    ]);
    await pool.query(
      "delete from customer_marketing_consents where dotypos_customer_id = any($1)",
      [created.consents]
    );
    await pool.query(
      "update email_campaign_automation_runs set trigger_reservation_id = null where trigger_reservation_id = any($1)",
      [created.reservations]
    );
    await pool.query("delete from workspace_reservations where id = any($1)", [
      created.reservations,
    ]);
    await pool.query("delete from customer_accounts where id = any($1)", [
      created.accounts,
    ]);
  };

  return {
    customerId,
    addCustomer,
    book,
    moveVisit,
    cancelVisit,
    deleteVisit,
    cancelInWorkspace,
    restoreInWorkspace,
    holdRestoreInWorkspace,
    recordEvent,
    deliverOneOffCampaign,
    holdPass,
    payIndividually,
    payFromEntryPack,
    cleanup,
    created,
  };
};

// ---------------------------------------------------------------------------
// The scenario

/** An instant as the test pool returns it (text or a `Date`), or `null`. */
export const databaseInstant = (value: Date | string | null | undefined) =>
  value === null || value === undefined
    ? null
    : Temporal.Instant.from(
        value instanceof Date ? value.toISOString() : value
      );

/** The queue's redelivery delay after a failed delivery (`retryAfterSeconds`). */
const automationQueueRetryAfter = { seconds: 60 } as const;

/** What one queue delivery did. */
export type AutomationScenarioDelivery = {
  readonly unitId: AutomationWorkUnitId;
  readonly outcome: AutomationUnitOutcome | "redelivered";
};

/** What `runUntil` saw when it stopped. */
export type AutomationScenarioProgress = {
  readonly at: Temporal.Instant;
  readonly ticks: number;
  readonly settled: boolean;
};

/**
 * One full engine over the test database, a mutable Dotypos fake, a Resend
 * fake and a queue fake that redelivers a failed message 60 s later, with
 * automations activated through `AutomationLifecycle` (`kit`). Every call
 * runs on a `TestClock` at the instant it's given.
 *
 * Call `prepare(at)` before the first planner run (it clears every unit and
 * moves the sweep cursors to `at`) and `cleanup()` in `afterAll`.
 */
export const makeAutomationEngineScenario = async (input: {
  readonly database: WorkspacePostgresSuiteDatabase;
  /** The instant lifecycle operations default to. */
  readonly now: Temporal.Instant;
  readonly prefix?: string;
  readonly kinds?: ReadonlyArray<AutomationWorkUnitKind>;
  readonly planning?: ReadonlyArray<AutomationScenarioPlanningStep>;
  readonly limits?: { readonly total: number; readonly deliver: number };
  readonly reconcile?: boolean;
  readonly deploymentEnvironment?: "production" | "development";
}) => {
  const { database } = input;
  const { pool } = database;
  const dotypos = makeEngineDotypos();
  const resend = makeResendFake();
  const queue = makeAutomationUnitQueueFake();
  const kit = automationLifecycleTestKit(database, { now: input.now });
  const prefix = input.prefix ?? `scenario-${kit.runId}`;
  const fixtures = makeEngineFixtures(database, dotypos, prefix);
  /** Failed deliveries, back on the queue once their retry delay passes. */
  const delayed: Array<{
    readonly message: AutomationUnitQueueFakeMessage;
    readonly availableAt: Temporal.Instant;
  }> = [];

  /**
   * Another deployment over the same database and fakes, as a rollout
   * leaves running beside this one (§9.1).
   */
  const deployment = async (options: {
    readonly kinds?: ReadonlyArray<AutomationWorkUnitKind>;
    readonly planning?: ReadonlyArray<AutomationScenarioPlanningStep>;
    readonly limits?: { readonly total: number; readonly deliver: number };
  }) => {
    const layer = await automationScenarioLayer({
      database,
      dotypos,
      queue,
      resend,
      kinds: options.kinds ?? input.kinds,
      planning: options.planning ?? input.planning,
      limits: options.limits ?? input.limits,
      reconcile: input.reconcile,
      deploymentEnvironment: input.deploymentEnvironment,
    });

    const run = <A, E>(
      effect: Effect.Effect<A, E, AutomationScenarioServices>,
      at: Temporal.Instant
    ) => runEngineAt(effect, layer, at);

    const plan = (at: Temporal.Instant) =>
      run(
        Effect.flatMap(AutomationPlanner, (planner) => planner.plan),
        at
      );

    /** Delivers one message to this deployment's processor at `at`. */
    const deliver = async (
      message: AutomationUnitQueueFakeMessage,
      at: Temporal.Instant
    ): Promise<AutomationScenarioDelivery> => {
      const result = await run(
        Effect.result(
          Effect.flatMap(AutomationUnitProcessor, (processor) =>
            processor.process(message.unitId)
          )
        ),
        at
      );
      if (Result.isFailure(result)) {
        delayed.push({
          message,
          availableAt: at.add(automationQueueRetryAfter),
        });
        return { unitId: message.unitId, outcome: "redelivered" };
      }
      return { unitId: message.unitId, outcome: result.success };
    };

    /** Moves failed deliveries whose retry delay has passed back onto the queue. */
    const release = (at: Temporal.Instant) => {
      for (let index = 0; index < delayed.length; ) {
        const entry = requireValue(delayed[index], "delayed queue message");
        if (Temporal.Instant.compare(entry.availableAt, at) <= 0) {
          queue.redeliver(entry.message);
          delayed.splice(index, 1);
        } else {
          index += 1;
        }
      }
    };

    /**
     * Processes the next due message at `at`; `undefined` when none is
     * pending. A failure goes back on the queue 60 s later.
     */
    const processNext = (at: Temporal.Instant) => {
      release(at);
      const message = queue.take();
      return message === undefined ? undefined : deliver(message, at);
    };

    /**
     * Processes `unitId`'s pending message (or, with none pending, a
     * delivery the queue never sent, as a duplicate would be) at `at`.
     */
    const process = (unitId: AutomationWorkUnitId, at: Temporal.Instant) => {
      release(at);
      const pending = queue.pending();
      const message = pending.find((m) => m.unitId === unitId);
      if (message !== undefined) {
        // Take it out of the queue, keeping the others in order.
        const rest = pending.filter((m) => m !== message);
        queue.dropPending();
        for (const other of rest) queue.redeliver(other);
      }
      return deliver(
        message ?? { unitId, idempotencyKey: `duplicate:${unitId}` },
        at
      );
    };

    /**
     * Starts processing `unitId` at `at` without waiting: `done` settles
     * with its delivery, and `interrupt` cuts the consumer off as the
     * platform's time limit would (the claim stays until it expires).
     */
    const start = (unitId: AutomationWorkUnitId, at: Temporal.Instant) => {
      const fiber = Effect.runFork(
        TestClock.setTime(at.epochMilliseconds).pipe(
          Effect.andThen(
            Effect.flatMap(AutomationUnitProcessor, (processor) =>
              processor.process(unitId)
            )
          ),
          Effect.provide(Layer.merge(layer, TestClock.layer()))
        )
      );
      const done = Effect.runPromise(Effect.result(Fiber.join(fiber)));
      // An interrupted consumer rejects `done`; callers that cut it off
      // needn't await it.
      done.catch(() => {});
      return {
        done,
        interrupt: () => Effect.runPromise(Fiber.interrupt(fiber)),
      };
    };

    /** Every pending message whose retry delay has passed, until none is left. */
    const drain = async (at: Temporal.Instant, maxDeliveries = 1000) => {
      const deliveries: AutomationScenarioDelivery[] = [];
      for (
        let next = processNext(at);
        next !== undefined && deliveries.length < maxDeliveries;
        next = processNext(at)
      ) {
        deliveries.push(await next);
      }
      return deliveries;
    };

    /** One planner run, then every queued unit until none is left. */
    const tick = async (at: Temporal.Instant) => {
      const summary = await plan(at);
      const deliveries = await drain(at);
      return { summary, deliveries };
    };

    /**
     * One planner run, then every queued unit except those of `kind`, so the
     * `kind` units that entry and condition units planned (D36) stay queued.
     */
    const planUntilQueued = async (
      at: Temporal.Instant,
      kind: AutomationWorkUnitKind
    ) => {
      const summary = await plan(at);
      for (;;) {
        const { rows } = await pool.query<{ id: AutomationWorkUnitId }>(
          "select id from email_campaign_automation_work_units where kind = $1 and id = any($2)",
          [kind, queue.pending().map((message) => message.unitId)]
        );
        const held = new Set(rows.map(({ id }) => id));
        const next = queue
          .pending()
          .find((message) => !held.has(message.unitId));
        if (next === undefined) return summary;
        await process(next.unitId, at);
      }
    };

    /**
     * Plans, runs the units ahead of the oldest enqueued deliver unit, then
     * cuts its consumer off while its batch request is with the provider. The unit stays
     * claimed with its batch persisted; other messages stay pending.
     */
    const killDuringRequest = async (at: Temporal.Instant) => {
      const reached = resend.nextRequest();
      await plan(at);
      const pendingDeliverUnit = async () => {
        const { rows } = await pool.query<{ id: AutomationWorkUnitId }>(
          "select id from email_campaign_automation_work_units where kind = 'deliver' and id = any($1) order by created_at limit 1",
          [queue.pending().map((message) => message.unitId)]
        );
        return rows[0]?.id;
      };
      // Entry and condition units plan the deliver unit as they commit (D36),
      // so the units ahead of it run first.
      let unitId = await pendingDeliverUnit();
      while (unitId === undefined) {
        const [next] = queue.pending();
        if (next === undefined) throw new Error("No deliver unit was enqueued");
        await process(next.unitId, at);
        unitId = await pendingDeliverUnit();
      }
      // Takes its message off the queue; the others stay pending.
      const rest = queue.pending().filter((m) => m.unitId !== unitId);
      queue.dropPending();
      for (const other of rest) queue.redeliver(other);
      const consumer = start(unitId, at);
      await reached;
      await consumer.interrupt();
      return unitId;
    };

    const lifecycle = <A, E>(
      operation: (
        service: AutomationLifecycle["Service"]
      ) => Effect.Effect<A, E>,
      at: Temporal.Instant = input.now
    ) => run(Effect.flatMap(AutomationLifecycle, operation), at);

    const health = (at: Temporal.Instant) =>
      run(
        Effect.flatMap(AutomationEngineHealth, (service) => service.get),
        at
      );

    return {
      layer,
      run,
      plan,
      processNext,
      process,
      start,
      drain,
      tick,
      planUntilQueued,
      killDuringRequest,
      lifecycle,
      health,
    };
  };

  const engine = await deployment({});

  /**
   * The next instant something falls due for the planner or the queue. A
   * run's due time, or an unprocessed event's occurrence, counts from the
   * tick it falls on: one after the tick `at` falls in is due on the tick
   * at or after it.
   */
  const nextDue = async (at: Temporal.Instant) => {
    const { rows } = await pool.query<{
      tick_due: Date | string | null;
      next: Date | string | null;
    }>(
      `select
         least(
           (select min(due_at) from email_campaign_automation_runs
             where status = 'active' and due_at > $2),
           (select min(occurred_at) from customer_events
             where automation_processed_at is null and occurred_at > $2)
         ) as tick_due,
         least(
           (select min(next_fire_at) from email_campaign_automations
             where next_fire_at > $1),
           (select min(claim_expires_at) from email_campaign_automation_work_units
             where status = 'claimed' and claim_expires_at > $1)
         ) as next`,
      [at.toString(), automationTickAtOrBefore(at).toString()]
    );
    const tickDue = databaseInstant(rows[0]?.tick_due);
    const candidates = [
      tickDue === null ? null : automationTickAtOrAfter(tickDue),
      databaseInstant(rows[0]?.next),
      ...delayed.map((entry) => entry.availableAt),
      // The sweep records a started or finished event once its time
      // passes, at the minute cron's next whole minute.
      ...[...dotypos.reservations.values()].flatMap((visit) =>
        [visit.startDate, visit.endDate]
          .filter((time): time is string => time !== undefined)
          .map((time) =>
            Temporal.Instant.from(time).round({
              smallestUnit: "minute",
              roundingMode: "ceil",
            })
          )
      ),
    ].filter(
      (time): time is Temporal.Instant =>
        time !== null && Temporal.Instant.compare(time, at) > 0
    );
    return candidates.reduce<Temporal.Instant | undefined>(
      (earliest, time) =>
        earliest === undefined || Temporal.Instant.compare(time, earliest) < 0
          ? time
          : earliest,
      undefined
    );
  };

  /**
   * Whether the next planner minute has work: open units, events intake
   * hasn't processed that occurred by the tick `at` falls in, ready runs of
   * an active automation, or its waiting runs due by that tick.
   */
  const hasPendingWork = async (at: Temporal.Instant) => {
    const { rows } = await pool.query<{ pending: boolean }>(
      `select exists (select 1 from email_campaign_automation_work_units
                       where status in ('planned', 'enqueued'))
           or exists (select 1 from customer_events
                       where automation_processed_at is null
                         and occurred_at <= $2)
           or exists (select 1 from email_campaign_automation_runs r
                        join email_campaigns c on c.id = r.campaign_id
                       where r.status = 'active' and c.status = 'active'
                         and r.due_at <= $1
                         and (r.phase = 'ready' or r.due_at <= $2))
           as pending`,
      [at.toString(), automationTickAtOrBefore(at).toString()]
    );
    return (
      requireValue(rows[0], "pending-work query row").pending ||
      queue.pending().length > 0
    );
  };

  /**
   * Ticks from `from` until `settled()` holds or `until` passes, jumping to
   * the next instant anything falls due (a run's `due_at`, a schedule's
   * `next_fire_at`, a claim's expiry, a redelivery, a visit's start or end)
   * and stepping one minute while units are open, so a long wait takes a
   * few ticks instead of one per minute.
   */
  const runUntil = async (options: {
    readonly from: Temporal.Instant;
    readonly until: Temporal.Instant;
    readonly settled?: () => Promise<boolean>;
    readonly maxTicks?: number;
    /**
     * Plans again at the same instant while work pends (up to 10 times),
     * as overlapping planner runs would, so work only a later planner run
     * picks up (a run a unit left `ready`, a replanned unit) completes at
     * its own instant. Condition chains need none: the units plan the
     * steps their runs reach (D36).
     */
    readonly sameInstant?: boolean;
    /**
     * Runs the engine as its cron does: one planner run and a queue drain on
     * tick instants only, every `emailAutomationTickMinutes` from the first
     * at or after `from`, skipping idle ticks to the first one at or after
     * the next due instant. The queue is drained only on ticks too.
     */
    readonly onTicks?: boolean;
  }): Promise<AutomationScenarioProgress> => {
    const maxTicks = options.maxTicks ?? 500;
    let at = options.onTicks
      ? automationTickAtOrAfter(options.from)
      : options.from;
    let repeats = 0;
    for (let ticks = 0; ticks < maxTicks; ) {
      await engine.tick(at);
      ticks += 1;
      if (options.settled && (await options.settled())) {
        return { at, ticks, settled: true };
      }
      const pending = await hasPendingWork(at);
      if (options.sameInstant && pending && repeats < 10) {
        repeats += 1;
        continue;
      }
      repeats = 0;
      const step = at.add({
        minutes: options.onTicks ? emailAutomationTickMinutes : 1,
      });
      const due = pending ? step : await nextDue(at);
      if (due === undefined) return { at, ticks, settled: !options.settled };
      const dueAt = options.onTicks ? automationTickAtOrAfter(due) : due;
      const next = Temporal.Instant.compare(dueAt, step) < 0 ? step : dueAt;
      if (Temporal.Instant.compare(next, options.until) > 0) {
        return { at, ticks, settled: false };
      }
      at = next;
    }
    return { at, ticks: maxTicks, settled: false };
  };

  /**
   * Clears every unit and points the sweep at `at`. The whole-table writes
   * reach only this suite's rows, since the database is its own.
   */
  const prepare = async (at: Temporal.Instant) => {
    await resetUnits();
    await pool.query(
      "update customer_event_sweeps set swept_until = $1, window_starts_at = null, window_ends_at = null, next_page = null",
      [at.toString()]
    );
    delayed.length = 0;
    queue.dropPending();
  };

  const resetUnits = async () => {
    await pool.query(
      "update email_campaign_automation_runs set work_unit_id = null where work_unit_id is not null"
    );
    await pool.query(
      "update customer_events set automation_unit_id = null where automation_unit_id is not null"
    );
    await pool.query("delete from email_campaign_automation_work_units");
  };

  // Database reads for assertions.
  const read = {
    runs: async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select * from email_campaign_automation_runs where campaign_id = $1 order by started_at, id",
          [campaignId]
        )
      ).rows,
    receipts: async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select * from email_campaign_automation_trigger_receipts where campaign_id = $1 order by received_at, dedup_key",
          [campaignId]
        )
      ).rows,
    fires: async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select * from email_campaign_automation_schedule_fires where campaign_id = $1 order by fire_at",
          [campaignId]
        )
      ).rows,
    units: async (campaignId?: CampaignId) =>
      (
        await pool.query(
          campaignId === undefined
            ? "select * from email_campaign_automation_work_units order by created_at, id"
            : "select * from email_campaign_automation_work_units where campaign_id = $1 order by created_at, id",
          campaignId === undefined ? [] : [campaignId]
        )
      ).rows,
    timeline: async (runId: string) =>
      (
        await pool.query(
          "select kind, step_id, at, detail from email_campaign_automation_run_events where run_id = $1 order by sequence",
          [runId]
        )
      ).rows,
    automation: async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select c.status, a.* from email_campaign_automations a join email_campaigns c on c.id = a.campaign_id where a.campaign_id = $1",
          [campaignId]
        )
      ).rows[0],
    sends: async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select * from email_campaign_sends where campaign_id = $1 order by created_at",
          [campaignId]
        )
      ).rows,
    recipients: async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select r.* from email_campaign_recipients r join email_campaign_sends s on s.id = r.send_id where s.campaign_id = $1 order by s.created_at, r.dotypos_customer_id",
          [campaignId]
        )
      ).rows,
    claims: async (campaignId: CampaignId) =>
      (
        await pool.query(
          "select * from email_campaign_automation_customer_claims where campaign_id = $1 order by dotypos_customer_id",
          [campaignId]
        )
      ).rows,
    events: async (ids: readonly string[]) =>
      (
        await pool.query(
          "select * from customer_events where id = any($1) order by occurred_at, id",
          [ids]
        )
      ).rows,
  };

  const cleanup = async () => {
    await resetUnits();
    // Claims outlive their runs' endings, so they go before the campaigns.
    await pool.query(
      "delete from email_campaign_automation_customer_claims where campaign_id = any($1)",
      [kit.campaignIds]
    );
    await kit.cleanup();
    await fixtures.cleanup();
  };

  return {
    ...engine,
    deployment,
    dotypos,
    resend,
    queue,
    kit,
    fixtures,
    delayed: () => [...delayed],
    runUntil,
    prepare,
    read,
    cleanup,
  };
};

/** A running scenario, as `makeAutomationEngineScenario` returns it. */
export type AutomationEngineScenario = Awaited<
  ReturnType<typeof makeAutomationEngineScenario>
>;
