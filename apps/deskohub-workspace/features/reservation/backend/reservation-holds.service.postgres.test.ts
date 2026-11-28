import { requireValue } from "@/shared/testing/require-value.test-utils";
import { dotyposHoldFixture } from "./workspace-reservation.test-utils";
import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterEach, describe, expect, type Mock, mock, test } from "bun:test";
import { PostHogDistinctId } from "@deskohub/analytics-posthog/identifiers";
import {
  type DotyposReservationId,
  DotyposReservationIdSchema,
  type DotyposReservationStatus,
  DotyposService,
  DotyposTableIdSchema,
  DotyposTableSchema,
  DotyposUnavailable,
  DotyposUncertain,
} from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { asc, eq, inArray } from "drizzle-orm";
import { Effect, Fiber, Latch, Layer, Ref, Result, Schema } from "effect";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { teamTableHoldClaims, workspaceReservations } from "@/db/schema";
import { holdsCustomerAccountSection } from "@/db/workspace-locks";
import { customerAgentClientIdSchema } from "@/features/account/backend/auth/customer-agent-authorization.service";
import type { CustomerAccountId } from "@/features/account/customer-account";
import { recordCheckoutAnalytics } from "@/features/checkout/backend/analytics/checkout-analytics.service.mock";
import { payStateDefaultTtlMilliseconds } from "@/features/checkout/backend/checkout";
import { deriveCheckoutAttemptKeys } from "@/features/checkout/backend/checkout/checkout-lookup-keys.server";
import {
  processReservationHoldCleanupScheduleMessage,
  ReservationHoldCleanupScheduleService,
  ReservationHoldCleanupService,
  UnpaidHoldRelease,
} from "@/features/checkout/backend/holds";
import { ProviderPaymentFinalizationService } from "@/features/checkout/backend/payment/provider-payment-finalization.service";
import { PaymentLifecycleRepository } from "@/features/checkout/backend/repositories/payment-lifecycle.repository";
import { WorkspaceTableAssignmentServiceMock } from "@/features/checkout/backend/reservation/workspace-table-assignment.service.mock";
import {
  type CheckoutAttemptId,
  type CheckoutSessionId,
  checkoutAttemptIdSchema,
  checkoutSessionIdSchema,
  promoteCheckoutAttemptToSessionId,
} from "@/features/checkout/checkout-identifiers";
import { workspaceProductMonitorOptionTableTags } from "@/features/checkout/product-catalog";
import { getTableReservationQuote } from "@/features/checkout/reservation-quote-table";
import { checkoutDetailsSchema } from "@/features/checkout/schemas/checkout-details";
import { getTableCheckoutDetails } from "@/features/checkout/schemas/checkout-details-table";
import { orderIdSchema } from "@/features/order";
import { EntryPackUnavailableError } from "@/features/passes/backend/entry-pack-redemption";
import { reservationOrderIssuanceSchema } from "@/features/reservation/reservation-order";
import { OpenSpaceTableMoves } from "@/features/team-table/backend/open-space-table-moves";
import { reconcileTeamTableHolds } from "@/features/team-table/backend/reconcile-team-table-holds";
import { TeamTableHoldClaims } from "@/features/team-table/backend/team-table-hold-claims";
import {
  QueueMessageSendError,
  QueuePublisher,
} from "@/shared/backend/queue/queue-publisher";
import { TestSealedStateKeys } from "@/shared/testing/sealed-state-keys.test-utils";
import {
  captureDatabaseQueryRowsWithExit,
  expectScalarDatabaseQueryAnnotations,
} from "@/shared/testing/workspace-database-query-log.test-utils";
import {
  syntheticDotyposCustomerId,
  workspaceFixtures,
} from "@/shared/testing/workspace-fixtures.test-utils";
import {
  holdPostgresTransaction,
  waitForAdvisoryLockWaiter,
} from "@/shared/testing/workspace-postgres-lock-waiters.test-utils";
import {
  connectWorkspacePostgresTestDatabase,
  requireTestDatabase,
} from "@/shared/testing/workspace-postgres-test-database.test-utils";
import { withInstantSleeps } from "@/shared/testing/workspace-test-clock.test-utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { workspaceReservationIdSchema } from "../persistence-contracts";
import { AdvisoryAvailabilityInventory } from "./availability-inventory";
import { agentSelectionKeySchema, type BookingAgent } from "./booking-agent";
import { GoogleCalendarWorkspaceLimitationsService } from "./google-calendar-workspace-limitations.service";
import {
  type ReservationHold,
  ReservationHolds,
} from "./reservation-holds.service";
import {
  type AvailabilityReservation,
  WorkspaceAvailabilityService,
  WorkspaceTableUnavailableError,
} from "./workspace-availability.service";
import {
  entryPackAttachCancellationFailureCode,
  type IWorkspaceReservationRepository,
  WorkspaceReservationRepository,
  WorkspaceReservationStateError,
} from "./workspace-reservation.repository";

const postgresDatabase = await connectWorkspacePostgresTestDatabase();

type HoldRequest = Parameters<
  (typeof ReservationHolds)["Service"]["holdForAttempt"]
>[0];

const reservation = Schema.decodeUnknownSync(
  reservationOrderIssuanceSchema("CZ")
)({
  kind: "cowork",
  entryTier: "open-space",
  date: "2099-06-10",
  coffee: false,
  name: "Ada Lovelace",
  email: testEmailAddress("ada"),
  phone: "+420 777 777 777",
  billing: { purpose: "personal", invoice: "none" },
});

/** The same visit with coffee: another selection, so another attempt key. */
const reservationWithCoffee = Schema.decodeUnknownSync(
  reservationOrderIssuanceSchema("CZ")
)({ ...reservation, coffee: true });

const checkoutDetails = Schema.decodeUnknownSync(checkoutDetailsSchema)({
  locale: "en-US",
  reservation: {
    kind: "cowork",
    entryTier: "open-space",
    date: "2099-06-10",
    coffee: false,
  },
  payment: {
    expectedPrice: { value: 29_000, exponent: 2, currency: "CZK" },
    undiscountedPrice: { value: 29_000, exponent: 2, currency: "CZK" },
    discounts: [],
    summary: {
      sections: [],
      total: { value: 29_000, exponent: 2, currency: "CZK" },
    },
  },
  legal: {},
});

const dotyposUnavailable = (operation: string) =>
  new DotyposUnavailable({ operation, reason: "server" });

/**
 * A created hold carries the deadline its reservation stores, to the
 * millisecond a Pay state signs; Postgres keeps only microseconds of it.
 */
const expectStoredHoldDeadline = (
  hold: ReservationHold,
  reservation:
    | { readonly reservationHoldExpiresAt: Temporal.Instant | null }
    | undefined
) => {
  if (hold.kind !== "created") throw new Error("Expected a created hold");
  expect(hold.reservationHoldExpiresAt.epochMilliseconds).toBe(
    reservation?.reservationHoldExpiresAt?.epochMilliseconds ?? Number.NaN
  );
};

describe.skipIf(!postgresDatabase)(
  "ReservationHolds.holdForAttempt on Postgres",
  () => {
    const postgres = requireTestDatabase(postgresDatabase);
    const authors: CustomerAccountId[] = [];

    afterEach(async () => {
      if (authors.length === 0) return;
      await postgres.db
        .delete(workspaceReservations)
        .where(inArray(workspaceReservations.authorAccountId, authors))
        .pipe(Effect.runPromise);
      authors.length = 0;
    });

    const newAuthor = async () => {
      const author = await workspaceFixtures(postgres.db)
        .customerAccount()
        .pipe(Effect.runPromise);
      authors.push(author);
      return author;
    };

    const newSessionId = () =>
      checkoutSessionIdSchema.make(`session-${crypto.randomUUID()}`);
    const newAttemptId = () =>
      checkoutAttemptIdSchema.make(`attempt-${crypto.randomUUID()}`);

    /**
     * Dotypos behind its service mock: each created hold gets a fresh id,
     * and every hold reads as `NEW` until a test says otherwise.
     */
    const makeDotypos = () => {
      const createdHolds: DotyposReservationId[] = [];
      const createReservation: Mock<
        DotyposService["Service"]["createReservation"]
      > = mock(() =>
        Effect.sync(() => {
          const id = DotyposReservationIdSchema.make(
            `dotypos-hold-${crypto.randomUUID()}`
          );
          createdHolds.push(id);
          return dotyposHoldFixture(id);
        })
      );
      const cancelReservation: Mock<
        DotyposService["Service"]["cancelReservation"]
      > = mock((_id: DotyposReservationId) => Effect.void);
      const getReservationStatus: Mock<
        DotyposService["Service"]["getReservationStatus"]
      > = mock((_id: DotyposReservationId) =>
        Effect.succeed<DotyposReservationStatus>("NEW")
      );
      return {
        createdHolds,
        createReservation,
        cancelReservation,
        getReservationStatus,
      };
    };
    type Dotypos = ReturnType<typeof makeDotypos>;

    const makeHolds = (
      options: {
        readonly dotypos?: Dotypos;
        readonly providerReads?: Pick<
          DotyposService["Service"],
          "listActiveReservationsOverlapping" | "getReservationWithoutCustomer"
        >;
        readonly conditionalCancel?: DotyposService["Service"]["setReservationStatusIfMatches"];
        readonly teamPlan?: WorkspaceAvailabilityService["Service"]["getLiveTeamTablePlan"];
        readonly ensureAvailable?: Mock<
          WorkspaceAvailabilityService["Service"]["ensureAvailable"]
        >;
        /** Wraps the Postgres repository the module reads and writes. */
        readonly observeReservations?: (
          reservations: IWorkspaceReservationRepository
        ) => IWorkspaceReservationRepository;
      } = {}
    ) => {
      const dotypos = options.dotypos ?? makeDotypos();
      const ensureAvailable: Mock<
        WorkspaceAvailabilityService["Service"]["ensureAvailable"]
      > = options.ensureAvailable ?? mock(() => Effect.void);
      const analytics = recordCheckoutAnalytics();
      const { observeReservations } = options;
      const reservations = WorkspaceReservationRepository.Default.pipe(
        Layer.provide(postgres.layer)
      );
      const enqueueCleanup: Mock<
        ReservationHoldCleanupScheduleService["Service"]["enqueueCleanup"]
      > = mock(() => Effect.void);
      const provider = Layer.mock(DotyposService, {
        createReservation: dotypos.createReservation,
        cancelReservation: dotypos.cancelReservation,
        getReservationStatus: dotypos.getReservationStatus,
        ...options.providerReads,
        ...(options.conditionalCancel && {
          setReservationStatusIfMatches: options.conditionalCancel,
        }),
      });
      const layer = ReservationHolds.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            WorkspaceDatabaseAdvisoryLock.makeLayer(postgres.databasePool),
            observeReservations
              ? Layer.effect(
                  WorkspaceReservationRepository,
                  Effect.map(
                    WorkspaceReservationRepository,
                    observeReservations
                  )
                ).pipe(Layer.provide(reservations))
              : reservations,
            Layer.mock(WorkspaceAvailabilityService, {
              ensureAvailable,
              ...(options.teamPlan && {
                getLiveTeamTablePlan: options.teamPlan,
              }),
            }),
            Layer.mock(OpenSpaceTableMoves, {
              repackInCapacitySection: () => Effect.succeed(true),
            }),
            provider,
            TeamTableHoldClaims.Default.pipe(
              Layer.provide(Layer.merge(postgres.layer, provider))
            ),
            WorkspaceTableAssignmentServiceMock({
              assignTableId: () =>
                Effect.succeed(DotyposTableIdSchema.make("table-id")),
            }),
            Layer.mock(ReservationHoldCleanupScheduleService, {
              enqueueCleanup,
            }),
            analytics.layer,
            TestSealedStateKeys
          )
        )
      );
      const hold = (request: HoldRequest) =>
        ReservationHolds.pipe(
          Effect.flatMap((holds) => holds.holdForAttempt(request)),
          Effect.provide(layer)
        );
      return {
        dotypos,
        ensureAvailable,
        enqueueCleanup,
        /** The `reservation started` events captured, by reservation id. */
        reservationsStarted: () =>
          analytics.messages
            .filter(({ event }) => event === "reservation started")
            .map(({ distinctId }) => distinctId),
        hold,
        reconcile: (now: Temporal.Instant) =>
          reconcileTeamTableHolds({ now, limit: 10 }).pipe(
            Effect.provide(TeamTableHoldClaims.Default),
            Effect.provide(
              Layer.mergeAll(
                postgres.layer,
                provider,
                reservations,
                WorkspaceDatabaseAdvisoryLock.makeLayer(postgres.databasePool)
              )
            ),
            Effect.runPromise
          ),
        holdForAttempt: (request: HoldRequest) =>
          hold(request).pipe(Effect.runPromise),
        /** The failure `holdForAttempt` ends with. */
        holdFailure: (request: HoldRequest) =>
          hold(request).pipe(Effect.flip, Effect.runPromise),
      };
    };

    /**
     * Holds for two requests of one attempt that race. Both pass the
     * availability check before either drafts, so both resume the same
     * draft, and neither claims its hold creation until both have it. The
     * winner's Dotypos write waits until the loser's claim has failed, and
     * the loser sees the outcome of its claim only once the winner has
     * attached or released the hold, so its first look at the reservation
     * finds it settled.
     */
    const makeRacingHolds = (dotypos = makeDotypos()) => {
      const countdown = (latch: Latch.Latch, ref: Ref.Ref<number>) =>
        Ref.updateAndGet(ref, (count) => count + 1).pipe(
          Effect.flatMap((count) => (count >= 2 ? latch.open : Effect.void))
        );
      const bothChecked = Effect.runSync(Latch.make());
      const checked = Effect.runSync(Ref.make(0));
      const bothDrafted = Effect.runSync(Latch.make());
      const drafted = Effect.runSync(Ref.make(0));
      const bothClaimed = Effect.runSync(Latch.make());
      const claimed = Effect.runSync(Ref.make(0));
      const settled = Effect.runSync(Latch.make());

      const ensureAvailable = mock(() =>
        countdown(bothChecked, checked).pipe(Effect.andThen(bothChecked.await))
      );
      const createHold = requireValue(
        dotypos.createReservation.getMockImplementation(),
        "createReservation mock"
      );
      dotypos.createReservation.mockImplementation((input) =>
        bothClaimed.await.pipe(Effect.andThen(createHold(input)))
      );
      return makeHolds({
        dotypos,
        ensureAvailable,
        observeReservations: (reservations) => ({
          ...reservations,
          claimHoldCreation: (id) =>
            countdown(bothDrafted, drafted).pipe(
              Effect.andThen(bothDrafted.await),
              Effect.andThen(reservations.claimHoldCreation(id)),
              Effect.tap(() => countdown(bothClaimed, claimed)),
              Effect.tap((won) => (won ? Effect.void : settled.await))
            ),
          attachHold: (input) =>
            reservations.attachHold(input).pipe(Effect.ensuring(settled.open)),
          releaseHoldCreation: (id) =>
            reservations
              .releaseHoldCreation(id)
              .pipe(Effect.ensuring(settled.open)),
        }),
      });
    };

    /** Runs two requests at once; each outcome as a `Result`. */
    const race = (
      holds: ReturnType<typeof makeHolds>,
      request: HoldRequest,
      rival: HoldRequest = request
    ) =>
      Effect.all(
        [request, rival].map((racing) =>
          holds.hold(racing).pipe(Effect.result)
        ),
        { concurrency: "unbounded" }
      ).pipe(Effect.runPromise);

    const holdRequest = (input: {
      readonly author: CustomerAccountId;
      readonly sessionId?: CheckoutSessionId;
      readonly attemptId?: CheckoutAttemptId;
      readonly customer?: HoldRequest["booking"]["customer"];
      readonly locale?: HoldRequest["booking"]["locale"];
      readonly bookedAt?: Temporal.Instant;
      readonly agent?: BookingAgent["Service"];
      readonly reservation?: HoldRequest["reservation"];
    }): HoldRequest => ({
      checkout: {
        sessionId: input.sessionId ?? newSessionId(),
        attemptId: input.attemptId ?? newAttemptId(),
      },
      reservation: input.reservation ?? reservation,
      booking: {
        author: input.author,
        customer: input.customer ?? syntheticDotyposCustomerId(),
        locale: input.locale ?? "en-US",
        purpose: "personal",
        bookedAt: input.bookedAt ?? Temporal.Now.instant(),
        ...(input.agent && { agent: input.agent }),
      },
      checkoutDetails,
    });

    test.each(["retry", "expiry", "hidden receipt", "attach failure"] as const)(
      "settles a lost Team Table POST without reposting (%s)",
      async (outcome) => {
        const author = await newAuthor();
        const dotypos = makeDotypos();
        const providerId = DotyposReservationIdSchema.make(
          "uncertain-team-hold"
        );
        const tableId = DotyposTableIdSchema.make("exact-team-table");
        const selection = {
          kind: "table",
          seats: 4,
          startsAt: "2099-06-10T09:00:00Z",
          endsAt: "2099-06-10T09:15:00Z",
        } as const;
        type ProviderHold = ReturnType<typeof dotyposHoldFixture>;
        const records: ProviderHold[] = [];
        let visible = false;
        dotypos.createReservation.mockImplementation((input) =>
          Effect.gen(function* () {
            expect(input).toMatchObject({
              tableId,
              seats: 4,
              singleAttempt: true,
            });
            const claims = yield* postgres.db
              .select()
              .from(teamTableHoldClaims)
              .where(eq(teamTableHoldClaims.tableId, tableId));
            expect(claims).toHaveLength(1);
            records.push({
              ...dotyposHoldFixture(providerId),
              _tableId: input.tableId,
              _customerId: input.customerId,
              seats: String(input.seats),
              startDate: input.startDate.toISOString(),
              endDate: input.endDate.toISOString(),
              note: input.note,
            });
            return yield* new DotyposUncertain({
              operation: "createReservation",
              request: "reservation.create",
              reason: "transport",
              message: "Synthetic lost reply",
            });
          })
        );
        const conditionalCancel = mock(() =>
          Effect.sync(() => ({
            ...requireValue(records[0], "posted hold"),
            status: "CANCELLED" as const,
          }))
        );
        const holds = makeHolds({
          dotypos,
          conditionalCancel,
          ...(outcome === "attach failure" && {
            observeReservations: (repository) => ({
              ...repository,
              attachHold: ({ id }) =>
                Effect.fail(
                  new WorkspaceReservationStateError({
                    operation: "attachHold",
                    reservationId: id,
                    message: "Synthetic attachment conflict",
                  })
                ),
            }),
          }),
          providerReads: {
            listActiveReservationsOverlapping: () =>
              Effect.sync(() => (visible ? records : [])),
            getReservationWithoutCustomer: () =>
              Effect.sync(() => requireValue(records[0], "posted hold")),
          },
        });
        const ordered = Schema.decodeUnknownSync(
          reservationOrderIssuanceSchema("CZ")
        )({ ...reservation, ...selection });
        if (ordered.kind !== "table")
          throw new Error("Expected a Team Table order");
        const quote = await getTableReservationQuote(ordered).pipe(
          Effect.runPromise
        );
        const request: HoldRequest = {
          ...holdRequest({ author }),
          reservation: ordered,
          checkoutDetails: getTableCheckoutDetails({
            locale: "en-US",
            reservation: ordered,
            quote,
            legalEvidence: {},
          }),
          teamTableCapacity: { assignTableId: Effect.succeed(tableId) },
        };
        expect((await holds.holdFailure(request))._tag).toBe(
          "DotyposUncertain"
        );
        expect((await rowsOf(author))[0]?.reservationState).toBe(
          "creating_hold"
        );
        const date = Temporal.PlainDate.from("2099-06-10");
        const capacity = await WorkspaceReservationRepository.pipe(
          Effect.flatMap((repository) =>
            repository.selectLocalTableCapacity({ first: date, last: date })
          ),
          Effect.provide(
            WorkspaceReservationRepository.Default.pipe(
              Layer.provide(postgres.layer)
            )
          ),
          Effect.runPromise
        );
        expect(capacity).toContainEqual(
          expect.objectContaining({ tableId, seats: 4, exclusive: true })
        );
        visible = outcome !== "hidden receipt";
        if (outcome === "expiry" || outcome === "hidden receipt") {
          await holds.reconcile(Temporal.Now.instant().add({ hours: 1 }));
          expect((await rowsOf(author))[0]?.reservationState).toBe(
            outcome === "expiry" ? "cancelled" : "hold_expired"
          );
          expect(conditionalCancel).toHaveBeenCalledTimes(
            outcome === "expiry" ? 1 : 0
          );
          expect((await holds.holdFailure(request))._tag).toBe(
            "CheckoutAttemptUnavailableError"
          );
          expect(dotypos.createReservation).toHaveBeenCalledTimes(1);
          return;
        }
        if (outcome === "attach failure") {
          expect((await holds.holdFailure(request))._tag).toBe(
            "WorkspaceReservationStateError"
          );
          expect(conditionalCancel).toHaveBeenCalledTimes(1);
          expect((await rowsOf(author))[0]?.reservationState).toBe("cancelled");
          expect((await holds.holdFailure(request))._tag).toBe(
            "CheckoutAttemptUnavailableError"
          );
          expect(dotypos.createReservation).toHaveBeenCalledTimes(1);
          return;
        }
        const recovered = await holds.holdForAttempt(request);
        expect(recovered).toMatchObject({
          kind: "reused",
          reservation: { dotyposReservationId: providerId },
        });
        expect(dotypos.createReservation).toHaveBeenCalledTimes(1);
      }
    );

    test.each(["original", "rotated", "rotated back to original"] as const)(
      "protects the superseded Team Table in the %s session until the replacement is available under lock",
      async (session) => {
        const rotates = session !== "original";
        const originalDate =
          session === "rotated back to original" ? "2099-06-11" : "2099-06-09";
        const author = await newAuthor();
        const sourceAuthor = await newAuthor();
        const sourceOrder = await Effect.runPromise(
          workspaceFixtures(postgres.db).reservation({
            stage: { reservation: "held" },
            overrides: { authorAccountId: sourceAuthor },
          })
        );
        const dotypos = makeDotypos();
        const tableId = DotyposTableIdSchema.make("own-table");
        const move = {
          reservationId: sourceOrder.id,
          sourceReservationId: requireValue(
            (await rowOf(sourceOrder.id))?.dotyposReservationId,
            "source provider hold"
          ),
          status: "NEW" as const,
          serviceDate: plainDateStringSchema.make("2099-06-11"),
          startsAt: Temporal.Instant.from("2099-06-11T00:00:00Z"),
          endsAt: Temporal.Instant.from("2099-06-11T15:00:00Z"),
          targetTableId: DotyposTableIdSchema.make("open-space-destination"),
        };
        const records = new Map<
          DotyposReservationId,
          ReturnType<typeof dotyposHoldFixture>
        >();
        let oldProviderId: DotyposReservationId | undefined;
        let lookahead = false;
        let replacementAvailable = true;
        dotypos.createReservation.mockImplementation((input) =>
          Effect.sync(() => {
            const id = DotyposReservationIdSchema.make(`table-${records.size}`);
            const record = {
              ...dotyposHoldFixture(id),
              _tableId: input.tableId,
              _customerId: input.customerId,
              startDate: input.startDate.toISOString(),
              endDate: input.endDate.toISOString(),
              seats: String(input.seats),
              note: input.note,
            };
            records.set(id, record);
            return record;
          })
        );
        dotypos.cancelReservation.mockImplementation((id) =>
          Effect.sync(() => {
            const current = records.get(id);
            if (current) records.set(id, { ...current, status: "CANCELLED" });
          })
        );
        const holds = makeHolds({
          dotypos,
          providerReads: {
            listActiveReservationsOverlapping: () =>
              Effect.sync(() =>
                [...records.values()].filter(
                  (record) => record.status === "NEW"
                )
              ),
            getReservationWithoutCustomer: (id) =>
              Effect.sync(() => requireValue(records.get(id), "provider hold")),
          },
          teamPlan: (_reservation, exactTable, options) =>
            Effect.sync(() => {
              if (!oldProviderId || exactTable) return { tableId, moves: [] };
              if (!replacementAvailable) return undefined;
              if (records.get(oldProviderId)?.status === "CANCELLED") {
                return { tableId, moves: [move] };
              }
              if (!options?.displacedHoldIds?.includes(oldProviderId))
                return undefined;
              lookahead = true;
              return { tableId, moves: [move] };
            }),
        });
        const base = holdRequest({ author });
        const tableRequest = async (date: string) => {
          const ordered = Schema.decodeUnknownSync(
            reservationOrderIssuanceSchema("CZ")
          )({
            ...reservation,
            kind: "table",
            seats: 4,
            startsAt: `${date}T09:00:00Z`,
            endsAt: `${date}T09:15:00Z`,
          });
          if (ordered.kind !== "table")
            throw new Error("Expected a Team Table");
          const quote = await Effect.runPromise(
            getTableReservationQuote(ordered)
          );
          return {
            ...base,
            checkout: rotates
              ? base.checkout
              : { ...base.checkout, attemptId: newAttemptId() },
            reservation: ordered,
            checkoutDetails: getTableCheckoutDetails({
              locale: "en-US",
              reservation: ordered,
              quote,
              legalEvidence: {},
            }),
          } satisfies HoldRequest;
        };
        let originalOrderId: string | undefined;
        if (rotates) {
          await holds.holdForAttempt({
            ...(await tableRequest(originalDate)),
            teamTableCapacity: {
              assignTableId: Effect.succeed(
                DotyposTableIdSchema.make("original-payment-table")
              ),
            },
          });
          originalOrderId = requireValue((await rowsOf(author))[0]).id;
          await setPaymentState(originalOrderId, "pending");
        }
        const previous = await holds.holdForAttempt({
          ...(await tableRequest("2099-06-10")),
          recheckTeamTableAuthority: Effect.void,
        });
        if (rotates) {
          expect(previous).toMatchObject({
            kind: "created",
            checkoutSessionId: promoteCheckoutAttemptToSessionId(
              base.checkout.attemptId
            ),
          });
        }
        if (previous.kind !== "created") throw new Error("Expected a new hold");
        oldProviderId = requireValue(
          (await rowOf(previous.reservationId))?.dotyposReservationId,
          "prior provider hold"
        );
        const replacement = {
          ...(await tableRequest("2099-06-11")),
          recheckTeamTableAuthority: Effect.all({
            author: holdsCustomerAccountSection(author),
            sourceAuthor: holdsCustomerAccountSection(sourceAuthor),
          }).pipe(
            Effect.tap((held) =>
              Effect.sync(() =>
                expect(held).toEqual({ author: true, sourceAuthor: true })
              )
            ),
            Effect.asVoid
          ),
        };
        replacementAvailable = false;
        expect(
          (
            await holds.holdFailure({
              ...replacement,
              recheckTeamTableAuthority: Effect.void,
            })
          )._tag
        ).toBe("WorkspaceTableUnavailableError");
        expect(dotypos.cancelReservation).not.toHaveBeenCalled();
        expect(await rowOf(previous.reservationId)).toMatchObject({
          reservationState: "held",
          dotyposReservationId: oldProviderId,
        });
        expect(records.get(oldProviderId)?.status).toBe("NEW");

        replacementAvailable = true;
        const key = ["reservation-capacity", "2099-06-10"] as const;
        const blocked = await holdPostgresTransaction(
          postgres.pool,
          "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          key
        );
        const waiting = holds.holdFailure(replacement);
        try {
          await waitForAdvisoryLockWaiter(postgres.pool, key);
          expect(lookahead).toBe(true);
          expect(dotypos.cancelReservation).not.toHaveBeenCalled();
          replacementAvailable = false;
        } finally {
          await blocked.commit();
        }
        expect((await waiting)._tag).toBe("WorkspaceTableUnavailableError");
        expect(dotypos.cancelReservation).not.toHaveBeenCalled();
        expect(await rowOf(previous.reservationId)).toMatchObject({
          reservationState: "held",
          dotyposReservationId: oldProviderId,
        });

        replacementAvailable = true;
        expect(await holds.holdForAttempt(replacement)).toMatchObject({
          kind: "created",
        });
        expect(dotypos.cancelReservation).toHaveBeenCalledTimes(1);
        expect(dotypos.cancelReservation).toHaveBeenCalledWith(oldProviderId);
        const rows = await rowsOf(author);
        expect(
          rows
            .filter(({ id }) => id !== originalOrderId)
            .map((row) => row.reservationState)
        ).toEqual(["cancelled", "held"]);
        if (originalOrderId) {
          expect(await rowOf(originalOrderId)).toMatchObject({
            reservationState: "held",
            paymentState: "pending",
          });
        }
      }
    );

    const rowsOf = (author: CustomerAccountId) =>
      postgres.db
        .select()
        .from(workspaceReservations)
        .where(eq(workspaceReservations.authorAccountId, author))
        .orderBy(asc(workspaceReservations.createdAt))
        .pipe(Effect.runPromise);

    const rowOf = async (id: string) => {
      const [row] = await postgres.db
        .select()
        .from(workspaceReservations)
        .where(
          eq(workspaceReservations.id, workspaceReservationIdSchema.make(id))
        )
        .pipe(Effect.runPromise);
      return row;
    };

    const setPaymentState = (id: string, paymentState: "pending" | "paid") =>
      postgres.pool.query(
        `update workspace_reservations
            set payment_state = $2,
                paid_at = case when $2 = 'paid' then now() end
          where id = $1`,
        [id, paymentState]
      );

    /** The attempt key the module stores for `request`'s attempt. */
    const storedAttemptKey = (request: HoldRequest) =>
      deriveCheckoutAttemptKeys({
        checkoutSessionId: request.checkout.sessionId,
        checkoutAttemptId: request.checkout.attemptId,
        reservation: request.reservation,
      }).pipe(
        Effect.map((keys) => keys.current),
        Effect.provide(TestSealedStateKeys),
        Effect.runSync
      );

    /**
     * Makes the database refuse every reservation update matching the
     * trigger condition `when`, as a failed write would, until `drop` runs.
     */
    const refuseUpdates = async (when: string) => {
      const name = `refuse_update_${crypto.randomUUID().replaceAll("-", "")}`;
      await postgres.pool.query(
        `create function ${name}() returns trigger language plpgsql as $$
         begin
           raise exception 'reservation update refused by the test';
         end;
         $$`
      );
      await postgres.pool.query(
        `create trigger ${name}
           before update on workspace_reservations
           for each row
           when (${when})
           execute function ${name}()`
      );
      return {
        drop: async () => {
          await postgres.pool.query(
            `drop trigger ${name} on workspace_reservations`
          );
          await postgres.pool.query(`drop function ${name}()`);
        },
      };
    };

    /**
     * Makes the database refuse to attach the Dotypos hold `dotyposId` to
     * its reservation until `drop` runs.
     */
    const refuseAttaching = (dotyposId: DotyposReservationId) =>
      refuseUpdates(
        `new.reservation_state = 'held'
           and new.dotypos_reservation_id = '${dotyposId}'`
      );

    describe("for the site and native apps", () => {
      test("creates one held reservation with its Dotypos hold for a first attempt", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });
        const before = Temporal.Now.instant();

        const hold = await holds.holdForAttempt(request);
        const after = Temporal.Now.instant();

        const rows = await rowsOf(author);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(hold).toEqual({
          kind: "created",
          reservationId: requireValue(row).id,
          checkoutSessionId: request.checkout.sessionId,
          reservationHoldExpiresAt: expect.any(Temporal.Instant),
        });
        expectStoredHoldDeadline(hold, row);
        expect(row?.reservationState).toBe("held");
        expect(row?.paymentState).toBe("not_started");
        expect(row?.dotyposCustomerId).toBe(request.booking.customer);
        expect(row?.checkoutAttemptKey).toBe(storedAttemptKey(request));
        expect(holds.ensureAvailable).toHaveBeenCalledTimes(1);
        expect(holds.ensureAvailable).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "cowork",
            date: "2099-06-10",
            entryTier: "open-space",
          }),
          { allowPassDayMove: true }
        );
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
        expect(holds.dotypos.createReservation.mock.calls[0]).toEqual([
          expect.objectContaining({
            customerId: request.booking.customer,
            status: "NEW",
          }),
        ]);
        expect(row?.dotyposReservationId).toBe(
          requireValue(holds.dotypos.createdHolds[0])
        );
        // A site hold lasts one Pay-state lifetime from when it's created.
        const expiresAt = requireValue(
          requireValue(row).reservationHoldExpiresAt
        ).epochMilliseconds;
        expect(expiresAt).toBeGreaterThanOrEqual(
          before.epochMilliseconds + payStateDefaultTtlMilliseconds
        );
        expect(expiresAt).toBeLessThanOrEqual(
          after.epochMilliseconds + payStateDefaultTtlMilliseconds
        );
        expect(holds.enqueueCleanup).toHaveBeenCalledTimes(1);
        const [cleanup] = requireValue(holds.enqueueCleanup.mock.calls[0]);
        expect(cleanup.orderId).toBe(requireValue(row).id);
        // Postgres keeps microseconds; the cleanup gets the instant as made.
        expect(cleanup.reservationHoldExpiresAt.epochMilliseconds).toBe(
          expiresAt
        );
      });

      test("annotates its query rows with the hold's ids and states, never its records", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });

        const { rows, exit } = await holds
          .hold(request)
          .pipe(captureDatabaseQueryRowsWithExit, Effect.runPromise);

        expect(exit._tag).toBe("Success");
        expectScalarDatabaseQueryAnnotations(rows);
        const [reservationRow] = await rowsOf(author);
        expect(rows).toContainEqual(
          expect.objectContaining({
            reservationId: requireValue(reservationRow).id,
            reservationState: expect.any(String),
            checkoutSessionKey: requireValue(reservationRow).checkoutSessionKey,
            checkoutAttemptKey: requireValue(reservationRow).checkoutAttemptKey,
            reservationKind: "cowork",
            discountCount: expect.any(Number),
            dotyposReservationId: holds.dotypos.createdHolds[0],
          })
        );
      });

      test("reuses the attempt's hold for an immediate retry and refreshes its details", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });
        const created = await holds.holdForAttempt(request);

        const retry = await holds.holdForAttempt({
          ...request,
          booking: { ...request.booking, locale: "cs-CZ" },
        });

        const rows = await rowsOf(author);
        expect(rows).toHaveLength(1);
        expect(created.kind).toBe("created");
        expect(retry).toMatchObject({
          kind: "reused",
          reservation: { id: requireValue(rows[0]).id },
          checkoutSessionId: request.checkout.sessionId,
        });
        expect(retry).not.toHaveProperty("pricedFor");
        expect(rows[0]?.locale).toBe("cs-CZ");
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
        // The retry schedules no second cleanup for the same hold.
        expect(holds.enqueueCleanup).toHaveBeenCalledTimes(1);
      });

      test("creates one Dotypos hold when identical requests race for an attempt", async () => {
        const author = await newAuthor();
        const request = holdRequest({ author });
        const holds = makeRacingHolds();

        const outcomes = await race(holds, request);

        const rows = await rowsOf(author);
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
        expect(rows).toHaveLength(1);
        const results = outcomes.map(Result.getOrThrow);
        expect(rows[0]?.reservationState).toBe("held");
        expect(results.map(({ kind }) => kind).sort()).toEqual([
          "created",
          "reused",
        ]);
        // The request that lost the claim prices the hold for the
        // customer the winner created it for.
        expect(results.find(({ kind }) => kind === "reused")).toMatchObject({
          reservation: { id: requireValue(rows[0]).id },
          pricedFor: request.booking.customer,
        });
      });

      // The booking re-quotes the hold for `pricedFor` only after this, so a
      // failed re-quote leaves the refreshed details and the captured start.
      test("refreshes the details and captures the start of the hold it reuses after losing the claim", async () => {
        const author = await newAuthor();
        const request = holdRequest({ author });
        const rival = {
          ...request,
          booking: { ...request.booking, locale: "cs-CZ" as const },
        };
        const holds = makeRacingHolds();

        const outcomes = await race(holds, request, rival);

        const results = outcomes.map(Result.getOrThrow);
        const loser = results.findIndex(({ kind }) => kind === "reused");
        expect(results[loser]).toHaveProperty(
          "pricedFor",
          request.booking.customer
        );
        const [row] = await rowsOf(author);
        expect(row?.locale).toBe([request, rival][loser]?.booking.locale);
        const reservationStartedId = PostHogDistinctId.make(
          requireValue(row).id
        );
        expect(holds.reservationsStarted()).toEqual([
          reservationStartedId,
          reservationStartedId,
        ]);
      });

      test("annotates the reused hold's query rows with its ids after losing the claim", async () => {
        const author = await newAuthor();
        const request = holdRequest({ author });
        const holds = makeRacingHolds();

        const { rows, exit } = await Effect.all(
          [holds.hold(request), holds.hold(request)],
          { concurrency: "unbounded" }
        ).pipe(captureDatabaseQueryRowsWithExit, Effect.runPromise);

        expect(exit._tag).toBe("Success");
        expectScalarDatabaseQueryAnnotations(rows);
        const [reservationRow] = await rowsOf(author);
        expect(rows).toContainEqual(
          expect.objectContaining({
            claimConflictReservationFound: true,
            reservationId: requireValue(reservationRow).id,
            reservationState: "held",
            dotyposReservationId: holds.dotypos.createdHolds[0],
          })
        );
      });

      test("fails without capturing a start when refreshing the hold it reuses after losing the claim fails", async () => {
        const author = await newAuthor();
        const request = holdRequest({ author });
        const holds = makeRacingHolds();
        // Only a reused hold's details refresh updates a held row.
        const refusal = await refuseUpdates(
          `old.author_account_id = '${author}'
             and old.reservation_state = 'held'
             and new.reservation_state = 'held'`
        );

        let outcomes: Awaited<ReturnType<typeof race>>;
        try {
          outcomes = await race(holds, request);
        } finally {
          await refusal.drop();
        }

        const [row] = await rowsOf(author);
        expect(row?.reservationState).toBe("held");
        expect(
          outcomes.map((outcome) =>
            Result.isSuccess(outcome) ? outcome.success : outcome.failure
          )
        ).toEqual(
          expect.arrayContaining([
            {
              kind: "created",
              reservationId: requireValue(row).id,
              checkoutSessionId: request.checkout.sessionId,
              reservationHoldExpiresAt: expect.any(Temporal.Instant),
            },
            expect.objectContaining({
              _tag: expect.stringMatching(/QueryError/),
            }),
          ])
        );
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
        expect(holds.dotypos.cancelReservation).not.toHaveBeenCalled();
        // Only the winner's start; the loser stopped at the refresh.
        expect(holds.reservationsStarted()).toEqual([
          PostHogDistinctId.make(requireValue(row).id),
        ]);
      });

      test("returns the draft with its claim released when Dotypos fails to create the hold", async () => {
        const author = await newAuthor();
        const dotypos = makeDotypos();
        const creationFailure = dotyposUnavailable("createReservation");
        dotypos.createReservation.mockImplementationOnce(() =>
          Effect.fail(creationFailure)
        );
        const holds = makeHolds({ dotypos });
        const request = holdRequest({ author });

        const failure = await holds.holdFailure(request);

        expect(failure).toBe(creationFailure);
        const [draft] = await rowsOf(author);
        expect(draft?.reservationState).toBe("draft");
        expect(draft?.dotyposReservationId).toBeNull();
        expect(dotypos.cancelReservation).not.toHaveBeenCalled();
        expect(holds.enqueueCleanup).not.toHaveBeenCalled();

        // The released claim lets the next try hold the same draft.
        const retry = await holds.holdForAttempt(request);
        const rows = await rowsOf(author);
        expect(rows).toHaveLength(1);
        expect(retry).toMatchObject({
          kind: "created",
          reservationId: requireValue(draft).id,
        });
        expect(rows[0]?.reservationState).toBe("held");
        expect(dotypos.createReservation).toHaveBeenCalledTimes(2);
      });

      test("releases an interrupted date-lock wait so the same attempt can be booked", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });
        if (request.reservation.kind !== "cowork")
          throw new Error("Expected cowork");
        const date = request.reservation.date;
        const key = ["reservation-capacity", date] as const;
        const held = await holdPostgresTransaction(
          postgres.pool,
          "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          key
        );
        const waiting = Effect.runFork(holds.hold(request));
        let draftId: string | undefined;
        try {
          await waitForAdvisoryLockWaiter(postgres.pool, key);
          await Effect.runPromise(Fiber.interrupt(waiting));
          const [draft] = await rowsOf(author);
          expect(draft?.reservationState).toBe("draft");
          draftId = draft?.id;
          expect(holds.dotypos.createReservation).not.toHaveBeenCalled();
        } finally {
          await held.commit();
          await Effect.runPromise(Fiber.interrupt(waiting));
        }
        expect(await holds.holdForAttempt(request)).toMatchObject({
          kind: "created",
          reservationId: draftId,
        });
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
      });

      test.each(["day", "overnight"] as const)(
        "checks the bare desk before retrying a pack-funded workstation hold for a %s stay",
        async (stay) => {
          const author = await newAuthor();
          const passId = orderIdSchema.make(crypto.randomUUID());
          const reservedDesk = Schema.decodeUnknownSync(
            reservationOrderIssuanceSchema("CZ")
          )({
            ...reservation,
            date: "2099-06-30",
            entryTier: "reserved-desk",
            coffee: false,
            monitorOption: "2x27-qhd",
            stay,
          });
          if (reservedDesk.kind !== "cowork")
            throw new Error("Expected cowork");
          const cart = holdRequest({ author, reservation: reservedDesk });
          const request: HoldRequest = {
            ...cart,
            checkoutDetails: {
              ...cart.checkoutDetails,
              reservation: {
                kind: "cowork",
                date: reservedDesk.date,
                entryTier: "reserved-desk",
                monitorOption: "2x27-qhd",
                stay,
              },
            },
            entryPack: {
              passId,
              holderAccountId: author,
              tier: "reserved-desk",
              date: reservedDesk.date,
            },
          };
          await postgres.pool.query(
            `insert into orders
            (id, kind, dotypos_customer_id, payment_state, fulfillment_state, paid_at)
            values ($1, 'pass-purchase', 'fixture-buyer', 'paid', 'not_started', now())`,
            [passId]
          );
          try {
            await postgres.pool.query(
              `insert into pass_purchases
              (id, buyer_account_id, holder_account_id, product, tier, entry_count, status, valid_from, valid_until, quote, locale, created_at)
              values ($1, $2, $2, 'entry-pack', 'reserved-desk', 5, 'active', '2099-06-01', '2099-07-01', '{}', 'en-US', now())`,
              [passId, author]
            );
            let bareDeskAvailable = false;
            const makeTable = (
              id: string,
              monitorTags: readonly string[] = []
            ) =>
              Schema.decodeSync(DotyposTableSchema)({
                _cloudId: "1",
                id,
                display: true,
                enabled: true,
                seats: "1",
                name: `Table ${id}`,
                tags: ["cowork:reserved-desk", ...monitorTags],
              });
            const bareDesk = makeTable("9");
            const workstation = makeTable(
              "10",
              workspaceProductMonitorOptionTableTags["2x27-qhd"]
            );
            const pendingDay = {
              passId: orderIdSchema.make(crypto.randomUUID()),
              customerId: syntheticDotyposCustomerId(),
              serviceDate: reservedDesk.date,
              tableId: bareDesk.id,
              tier: "reserved-desk" as const,
              holdRequestedAt: null,
              holdAmbiguous: false,
              holdGeneration: null,
              providerReservationId: null,
            };
            const availability = WorkspaceAvailabilityService.Default.pipe(
              Layer.provide(AdvisoryAvailabilityInventory.Provider),
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(DotyposService, {
                    getTables: () => Effect.succeed([bareDesk, workstation]),
                    listActiveReservationsOverlapping: () => Effect.succeed([]),
                  }),
                  Layer.mock(GoogleCalendarWorkspaceLimitationsService, {
                    listLimitations: () => Effect.succeed([]),
                  }),
                  Layer.mock(WorkspaceReservationRepository, {
                    selectLocalTableCapacity: () => Effect.succeed([]),
                    selectPendingPassDayCapacity: () =>
                      Effect.sync(() =>
                        bareDeskAvailable ? [] : [pendingDay]
                      ),
                    selectExpiredHoldDotyposReservationIds: () =>
                      Effect.succeed([]),
                  })
                )
              )
            );
            const ensureAvailable = mock((candidate: AvailabilityReservation) =>
              Effect.flatMap(WorkspaceAvailabilityService, (service) =>
                service.ensureAvailable(candidate)
              ).pipe(Effect.provide(availability))
            );
            const dotypos = makeDotypos();
            const createFailed = dotyposUnavailable("createReservation");
            dotypos.createReservation.mockImplementationOnce(() =>
              Effect.fail(createFailed)
            );
            const holds = makeHolds({ dotypos, ensureAvailable });

            expect(await holds.holdFailure(request)).toBe(createFailed);
            expect(await rowsOf(author)).toMatchObject([
              { reservationState: "draft", dotyposReservationId: null },
            ]);

            bareDeskAvailable = true;
            expect(await holds.holdFailure(request)).toMatchObject({
              _tag: "EntryPackUnavailableError",
            });
            expect(await rowsOf(author)).toMatchObject([
              { reservationState: "draft", dotyposReservationId: null },
            ]);
            expect(dotypos.createReservation).toHaveBeenCalledTimes(1);
            expect(
              await postgres.pool.query(
                "select status from pass_entry_claims where pass_id = $1",
                [passId]
              )
            ).toMatchObject({ rows: [] });

            bareDeskAvailable = false;
            await holds.holdForAttempt(request);
            expect(
              await postgres.pool.query(
                "select status, date::text from pass_entry_claims where pass_id = $1",
                [passId]
              )
            ).toMatchObject({
              rows: [{ status: "reserved", date: "2099-06-30" }],
            });
          } finally {
            await postgres.pool.query(
              "delete from pass_entry_claims where pass_id = $1",
              [passId]
            );
            await postgres.pool.query(
              "delete from pass_purchases where id = $1",
              [passId]
            );
            await postgres.pool.query("delete from orders where id = $1", [
              passId,
            ]);
          }
        }
      );

      test("cancels the Dotypos hold and releases the claim when attaching it fails", async () => {
        const author = await newAuthor();
        const dotyposId = DotyposReservationIdSchema.make(
          `dotypos-hold-${crypto.randomUUID()}`
        );
        const dotypos = makeDotypos();
        dotypos.createReservation.mockImplementationOnce(() =>
          Effect.succeed(dotyposHoldFixture(dotyposId))
        );
        const holds = makeHolds({ dotypos });
        const refusal = await refuseAttaching(dotyposId);

        try {
          const failure = await holds.holdFailure(holdRequest({ author }));

          expect(failure).toMatchObject({
            _tag: expect.stringMatching(/QueryError/),
          });
        } finally {
          await refusal.drop();
        }
        const rows = await rowsOf(author);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.reservationState).toBe("draft");
        expect(rows[0]?.dotyposReservationId).toBeNull();
        expect(dotypos.cancelReservation.mock.calls).toEqual([[dotyposId]]);
        expect(holds.enqueueCleanup).not.toHaveBeenCalled();
      });

      test("marks the hold for cancellation when attaching it and cancelling it both fail", async () => {
        const author = await newAuthor();
        const dotyposId = DotyposReservationIdSchema.make(
          `dotypos-hold-${crypto.randomUUID()}`
        );
        const cancellationFailure = dotyposUnavailable("cancelReservation");
        const dotypos = makeDotypos();
        dotypos.createReservation.mockImplementationOnce(() =>
          Effect.succeed(dotyposHoldFixture(dotyposId))
        );
        dotypos.cancelReservation.mockImplementationOnce(() =>
          Effect.fail(cancellationFailure)
        );
        const holds = makeHolds({ dotypos });
        const refusal = await refuseAttaching(dotyposId);

        try {
          const failure = await holds.holdFailure(holdRequest({ author }));

          expect(failure).toBe(cancellationFailure);
        } finally {
          await refusal.drop();
        }
        const rows = await rowsOf(author);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          reservationState: "cancellation_failed",
          failureCode: "attach_failed_cancel_failed",
          dotyposReservationId: dotyposId,
        });
        expect(rows[0]?.reservationCreatedAt).not.toBeNull();
        expect(dotypos.cancelReservation.mock.calls).toEqual([[dotyposId]]);
      });

      const failedEntryPackAttachment = async (options: {
        readonly resumeDraft?: true;
        readonly queueDown?: true;
      }) => {
        const author = await newAuthor();
        const base = holdRequest({ author });
        if (base.reservation.kind !== "cowork")
          throw new Error("Expected cowork");
        const request = {
          ...base,
          entryPack: {
            passId: orderIdSchema.make(crypto.randomUUID()),
            holderAccountId: author,
            tier: "open-space" as const,
            date: base.reservation.date,
          },
        };
        const dotypos = makeDotypos();
        const cancelFailed = dotyposUnavailable("cancelReservation");
        dotypos.cancelReservation.mockImplementationOnce(() =>
          Effect.fail(cancelFailed)
        );
        const holds = makeHolds({
          dotypos,
          observeReservations: (repository) => ({
            ...repository,
            checkEntryPackAvailable: () => Effect.void,
            attachHold: () => Effect.fail(new EntryPackUnavailableError({})),
          }),
        });
        if (options.resumeDraft) {
          const createFailed = dotyposUnavailable("createReservation");
          dotypos.createReservation.mockImplementationOnce(() =>
            Effect.fail(createFailed)
          );
          expect(await holds.holdFailure(request)).toBe(createFailed);
          const [draft] = await rowsOf(author);
          const earlierDeadline = requireValue(
            requireValue(draft).reservationHoldExpiresAt
          ).subtract({
            minutes: 3,
          });
          await postgres.db
            .update(workspaceReservations)
            .set({ reservationHoldExpiresAt: earlierDeadline })
            .where(eq(workspaceReservations.id, requireValue(draft).id))
            .pipe(Effect.runPromise);
        }
        if (options.queueDown) {
          holds.enqueueCleanup.mockImplementationOnce((input) =>
            ReservationHoldCleanupScheduleService.pipe(
              Effect.flatMap((service) => service.enqueueCleanup(input)),
              Effect.provide(
                ReservationHoldCleanupScheduleService.Default.pipe(
                  Layer.provide(
                    Layer.mock(QueuePublisher, {
                      publish: ({ topic }) =>
                        Effect.fail(
                          new QueueMessageSendError({
                            topic,
                            cause: new Error("Synthetic queue failure"),
                          })
                        ),
                    })
                  )
                )
              )
            )
          );
        }
        expect(await holds.holdFailure(request)).toBe(cancelFailed);
        const [failed] = await rowsOf(author);
        expect(failed).toMatchObject({
          reservationState: "cancellation_failed",
          failureCode: entryPackAttachCancellationFailureCode,
          dotyposReservationId: dotypos.createdHolds[0],
        });
        const cleanup = ReservationHoldCleanupService.Default.pipe(
          Layer.provide(UnpaidHoldRelease.Default),
          Layer.provide(
            Layer.mergeAll(
              WorkspaceReservationRepository.Default.pipe(
                Layer.provide(postgres.layer)
              ),
              WorkspaceDatabaseAdvisoryLock.makeLayer(postgres.databasePool),
              Layer.mock(PaymentLifecycleRepository, {}),
              Layer.mock(ProviderPaymentFinalizationService, {}),
              recordCheckoutAnalytics().layer,
              Layer.mock(DotyposService, dotypos)
            )
          )
        );
        return {
          cleanup,
          dotypos,
          failed: requireValue(failed),
          enqueueCleanup: holds.enqueueCleanup,
        };
      };

      test("cancels a resumed draft through the queue using its stored deadline", async () => {
        const { cleanup, failed, enqueueCleanup, dotypos } =
          await failedEntryPackAttachment({ resumeDraft: true });
        expect(enqueueCleanup).toHaveBeenCalledTimes(1);
        const [queued] = requireValue(enqueueCleanup.mock.calls[0]);
        expect(queued.orderId).toBe(failed.id);
        expect(
          await processReservationHoldCleanupScheduleMessage(
            {
              orderId: queued.orderId,
              reservationHoldExpiresAtIso:
                queued.reservationHoldExpiresAt.toString(),
            },
            requireValue(failed.reservationHoldExpiresAt).add({ seconds: 1 })
          ).pipe(Effect.provide(cleanup), Effect.runPromise)
        ).toBe("cancelled");
        expect(await rowOf(failed.id)).toMatchObject({
          reservationState: "cancelled",
        });
        expect(dotypos.cancelReservation).toHaveBeenCalledTimes(2);
      });

      test("a failed pack attachment remains sweepable after a transient Dotypos failure", async () => {
        const { cleanup, failed, dotypos } = await failedEntryPackAttachment({
          queueDown: true,
        });
        const sweep = () =>
          ReservationHoldCleanupService.pipe(
            Effect.flatMap((service) =>
              service.sweepExpiredHolds({
                now: requireValue(failed.reservationHoldExpiresAt).add({
                  seconds: 1,
                }),
                limit: 100,
              })
            ),
            Effect.provide(cleanup),
            Effect.runPromise
          );
        let firstRead = true;
        const readHoldStatus = requireValue(
          dotypos.getReservationStatus.getMockImplementation()
        );
        dotypos.getReservationStatus.mockImplementation((id) => {
          if (id === failed.dotyposReservationId && firstRead) {
            firstRead = false;
            return Effect.fail(dotyposUnavailable("getReservationStatus"));
          }
          return readHoldStatus(id);
        });
        expect((await sweep()).failed).toBeGreaterThanOrEqual(1);
        expect(await rowOf(failed.id)).toMatchObject({
          reservationState: "cancellation_failed",
          failureCode: entryPackAttachCancellationFailureCode,
        });
        expect((await sweep()).cancelled).toBeGreaterThanOrEqual(1);
        expect(await rowOf(failed.id)).toMatchObject({
          reservationState: "cancelled",
        });
        expect(
          dotypos.cancelReservation.mock.calls.filter(
            ([id]) => id === failed.dotyposReservationId
          )
        ).toHaveLength(2);
      });

      test("refuses an attempt whose hold creation stays in flight", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });
        await workspaceFixtures(postgres.db)
          .reservation({
            stage: { reservation: "creating_hold" },
            author,
            customer: request.booking.customer,
            overrides: { checkoutAttemptKey: storedAttemptKey(request) },
          })
          .pipe(Effect.runPromise);

        const failure = await holds
          .hold(request)
          .pipe(Effect.flip, withInstantSleeps, Effect.runPromise);

        expect(failure._tag).toBe("CheckoutAttemptUnavailableError");
        expect(holds.dotypos.createReservation).not.toHaveBeenCalled();
        const rows = await rowsOf(author);
        expect(rows.map((row) => row.reservationState)).toEqual([
          "creating_hold",
        ]);
      });

      test.each([
        ["hold", "held"],
        ["draft", "draft"],
      ] as const)(
        "refuses to resume an attempt whose %s another account authored",
        async (_label, state) => {
          const holder = await newAuthor();
          const other = await newAuthor();
          const dotypos = makeDotypos();
          if (state === "draft") {
            // A failed hold creation leaves the holder's attempt a draft.
            dotypos.createReservation.mockImplementationOnce(() =>
              Effect.fail(dotyposUnavailable("createReservation"))
            );
          }
          const holds = makeHolds({ dotypos });
          const request = holdRequest({ author: holder });
          await holds.hold(request).pipe(Effect.result, Effect.runPromise);

          const failure = await holds.holdFailure({
            ...request,
            booking: { ...request.booking, author: other },
          });

          expect(failure._tag).toBe("CheckoutAttemptUnavailableError");
          expect(dotypos.createReservation).toHaveBeenCalledTimes(1);
          expect(await rowsOf(other)).toEqual([]);
          expect((await rowsOf(holder))[0]?.reservationState).toBe(state);
        }
      );

      test("reports the conflict when the request holding the claim leaves no usable hold", async () => {
        const author = await newAuthor();
        const request = holdRequest({ author });
        const creationFailure = dotyposUnavailable("createReservation");
        const dotypos = makeDotypos();
        dotypos.createReservation.mockImplementation(() =>
          Effect.fail(creationFailure)
        );
        const holds = makeRacingHolds(dotypos);

        const outcomes = await race(holds, request);

        expect(dotypos.createReservation).toHaveBeenCalledTimes(1);
        expect(
          outcomes.map((outcome) =>
            Result.isSuccess(outcome) ? outcome.success : outcome.failure
          )
        ).toEqual(
          expect.arrayContaining([{ kind: "contended" }, creationFailure])
        );
        const rows = await rowsOf(author);
        expect(rows.map((row) => row.reservationState)).toEqual(["draft"]);
      });

      test("moves an attempt whose reservation ended into the attempt's own session", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });
        await holds.holdForAttempt(request);
        const [ended] = await rowsOf(author);
        await postgres.pool.query(
          `update workspace_reservations
              set reservation_state = 'cancelled', reservation_cancelled_at = now()
            where id = $1`,
          [requireValue(ended).id]
        );

        const hold = await holds.holdForAttempt(request);

        const replacement = (await rowsOf(author)).find(
          (row) => row.id !== requireValue(ended).id
        );
        expect(hold).toEqual({
          kind: "created",
          reservationId: requireValue(replacement).id,
          checkoutSessionId: promoteCheckoutAttemptToSessionId(
            request.checkout.attemptId
          ),
          reservationHoldExpiresAt: expect.any(Temporal.Instant),
        });
        expectStoredHoldDeadline(hold, replacement);
        expect(replacement?.checkoutSessionKey).not.toBe(
          requireValue(ended).checkoutSessionKey
        );
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(2);
      });

      test("refuses an attempt whose unpaid hold lapsed", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });
        await holds.holdForAttempt(request);
        const [lapsed] = await rowsOf(author);
        await postgres.pool.query(
          `update workspace_reservations
              set reservation_hold_expires_at = now() - interval '1 minute'
            where id = $1`,
          [requireValue(lapsed).id]
        );

        const failure = await holds.holdFailure(request);

        expect(failure._tag).toBe("CheckoutAttemptUnavailableError");
        expect(await rowsOf(author)).toHaveLength(1);
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
        expect(holds.dotypos.cancelReservation).not.toHaveBeenCalled();
      });

      test("refuses to reuse an attempt's hold without a stored deadline", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const request = holdRequest({ author });
        await holds.holdForAttempt(request);
        const [undated] = await rowsOf(author);
        await postgres.pool.query(
          `update workspace_reservations
              set reservation_hold_expires_at = null
            where id = $1`,
          [requireValue(undated).id]
        );

        const failure = await holds.holdFailure(request);

        expect(failure._tag).toBe("CheckoutAttemptUnavailableError");
        expect(await rowsOf(author)).toHaveLength(1);
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
      });

      test("refuses a session whose current draft stays unsettled", async () => {
        const author = await newAuthor();
        const dotypos = makeDotypos();
        dotypos.createReservation.mockImplementationOnce(() =>
          Effect.fail(dotyposUnavailable("createReservation"))
        );
        const holds = makeHolds({ dotypos });
        const sessionId = newSessionId();
        // A failed hold creation leaves the session's current reservation a draft.
        await holds.holdFailure(holdRequest({ author, sessionId }));

        const failure = await holds
          .hold(holdRequest({ author, sessionId }))
          .pipe(Effect.flip, withInstantSleeps, Effect.runPromise);

        expect(failure._tag).toBe("CheckoutAttemptUnavailableError");
        expect(dotypos.createReservation).toHaveBeenCalledTimes(1);
        const rows = await rowsOf(author);
        expect(rows.map((row) => row.reservationState)).toEqual(["draft"]);
      });

      test("drafts nothing for an unavailable selection", async () => {
        const author = await newAuthor();
        const unavailable = new WorkspaceTableUnavailableError({
          date: "2099-06-10",
          reservation: {
            kind: "cowork",
            entryTier: "open-space",
          },
        });
        const holds = makeHolds({
          ensureAvailable: mock(() => Effect.fail(unavailable)),
        });

        const failure = await holds.holdFailure(holdRequest({ author }));

        expect(failure).toBe(unavailable);
        expect(await rowsOf(author)).toEqual([]);
        expect(holds.dotypos.createReservation).not.toHaveBeenCalled();
      });
    });

    describe("in a session that already holds a reservation", () => {
      const holdInSession = async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const sessionId = newSessionId();
        const customer = syntheticDotyposCustomerId();
        const first = holdRequest({ author, sessionId, customer });
        await holds.holdForAttempt(first);
        const [previous] = await rowsOf(author);
        const next = holdRequest({ author, sessionId, customer });
        return {
          author,
          holds,
          sessionId,
          customer,
          previous: requireValue(previous, "previous hold"),
          next,
        };
      };

      test("cancels the previous hold in Dotypos and holds the new attempt in the same session", async () => {
        const { author, holds, sessionId, previous, next } =
          await holdInSession();

        const hold = await holds.holdForAttempt(next);

        const rows = await rowsOf(author);
        const replacement = rows.find((row) => row.id !== previous.id);
        expect(hold).toEqual({
          kind: "created",
          reservationId: requireValue(replacement).id,
          checkoutSessionId: sessionId,
          reservationHoldExpiresAt: expect.any(Temporal.Instant),
        });
        expectStoredHoldDeadline(hold, replacement);
        expect(holds.dotypos.getReservationStatus.mock.calls).toEqual([
          [requireValue(previous.dotyposReservationId)],
        ]);
        expect(holds.dotypos.cancelReservation.mock.calls).toEqual([
          [requireValue(previous.dotyposReservationId)],
        ]);
        expect(await rowOf(previous.id)).toMatchObject({
          reservationState: "cancelled",
          reservationCancelledAt: expect.anything(),
        });
        expect(replacement).toMatchObject({
          reservationState: "held",
          checkoutSessionKey: previous.checkoutSessionKey,
        });
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(2);
        // The replacement checks availability again once the previous hold
        // is cancelled.
        expect(holds.ensureAvailable).toHaveBeenCalledTimes(2);
      });

      test("cancels the claimed previous hold locally when the new selection is unavailable", async () => {
        const { author, holds, previous, next } = await holdInSession();
        const unavailable = new WorkspaceTableUnavailableError({
          date: "2099-06-10",
          reservation: {
            kind: "cowork",
            entryTier: "open-space",
          },
        });
        holds.ensureAvailable.mockImplementationOnce(() =>
          Effect.fail(unavailable)
        );

        const failure = await holds.holdFailure(next);

        expect(failure).toBe(unavailable);
        expect(holds.dotypos.cancelReservation.mock.calls).toEqual([
          [requireValue(previous.dotyposReservationId)],
        ]);
        const rows = await rowsOf(author);
        expect(rows.map((row) => [row.id, row.reservationState])).toEqual([
          [previous.id, "cancelled"],
        ]);
      });

      test("moves into the attempt's own session instead of cancelling a hold whose payment started", async () => {
        const { author, holds, previous, next } = await holdInSession();
        await setPaymentState(previous.id, "pending");

        const hold = await holds.holdForAttempt(next);

        const replacement = (await rowsOf(author)).find(
          (row) => row.id !== previous.id
        );
        expect(hold).toMatchObject({
          kind: "created",
          reservationId: requireValue(replacement).id,
          checkoutSessionId: promoteCheckoutAttemptToSessionId(
            next.checkout.attemptId
          ),
        });
        expect(replacement?.checkoutSessionKey).not.toBe(
          previous.checkoutSessionKey
        );
        expect(await rowOf(previous.id)).toMatchObject({
          reservationState: "held",
          paymentState: "pending",
        });
        expect(holds.dotypos.getReservationStatus).not.toHaveBeenCalled();
        expect(holds.dotypos.cancelReservation).not.toHaveBeenCalled();
      });

      test("moves into the attempt's own session when Dotypos no longer keeps the previous hold pending", async () => {
        const { author, holds, previous, next } = await holdInSession();
        holds.dotypos.getReservationStatus.mockImplementationOnce(() =>
          Effect.succeed<DotyposReservationStatus>("CONFIRMED")
        );

        const hold = await holds.holdForAttempt(next);

        expect(hold).toMatchObject({
          kind: "created",
          checkoutSessionId: promoteCheckoutAttemptToSessionId(
            next.checkout.attemptId
          ),
        });
        expect(holds.dotypos.cancelReservation).not.toHaveBeenCalled();
        expect(await rowOf(previous.id)).toMatchObject({
          reservationState: "cancellation_failed",
          failureCode: "checkout_supersession_cancel_failed",
        });
        expect(await rowsOf(author)).toHaveLength(2);
      });

      test("moves into the attempt's own session when cancelling the previous hold fails", async () => {
        const { author, holds, previous, next } = await holdInSession();
        holds.dotypos.cancelReservation.mockImplementationOnce(() =>
          Effect.fail(dotyposUnavailable("cancelReservation"))
        );

        const hold = await holds.holdForAttempt(next);

        expect(hold).toMatchObject({
          kind: "created",
          checkoutSessionId: promoteCheckoutAttemptToSessionId(
            next.checkout.attemptId
          ),
        });
        expect(await rowOf(previous.id)).toMatchObject({
          reservationState: "cancellation_failed",
          failureCode: "checkout_supersession_cancel_failed",
        });
        expect(await rowsOf(author)).toHaveLength(2);
      });

      test("moves into the attempt's own session instead of superseding another account's hold", async () => {
        const { holds, sessionId, previous } = await holdInSession();
        const other = await newAuthor();

        const hold = await holds.holdForAttempt(
          holdRequest({ author: other, sessionId })
        );

        const [otherHold] = await rowsOf(other);
        expect(hold).toMatchObject({
          kind: "created",
          reservationId: requireValue(otherHold).id,
        });
        expect(hold).not.toMatchObject({ checkoutSessionId: sessionId });
        expect(otherHold?.checkoutSessionKey).not.toBe(
          previous.checkoutSessionKey
        );
        expect(await rowOf(previous.id)).toMatchObject({
          reservationState: "held",
        });
        expect(holds.dotypos.cancelReservation).not.toHaveBeenCalled();
      });

      test("supersedes the hold it left in the attempt's own session after moving there", async () => {
        const { author, holds, sessionId, customer, previous } =
          await holdInSession();
        await setPaymentState(previous.id, "pending");
        const attemptId = newAttemptId();
        const ownSessionId = promoteCheckoutAttemptToSessionId(attemptId);
        await holds.holdForAttempt(
          holdRequest({ author, sessionId, attemptId, customer })
        );
        const [rotated] = (await rowsOf(author)).filter(
          (row) => row.id !== previous.id
        );

        // The same attempt with another selection is a new attempt key in
        // the same own session, whose hold it supersedes.
        const hold = await holds.holdForAttempt(
          holdRequest({
            author,
            sessionId,
            attemptId,
            customer,
            reservation: reservationWithCoffee,
          })
        );

        const replacement = (await rowsOf(author)).find(
          (row) => row.id !== previous.id && row.id !== requireValue(rotated).id
        );
        expect(hold).toEqual({
          kind: "created",
          reservationId: requireValue(replacement).id,
          checkoutSessionId: ownSessionId,
          reservationHoldExpiresAt: expect.any(Temporal.Instant),
        });
        expectStoredHoldDeadline(hold, replacement);
        expect(replacement?.checkoutSessionKey).toBe(
          requireValue(rotated).checkoutSessionKey
        );
        expect(await rowOf(requireValue(rotated).id)).toMatchObject({
          reservationState: "cancelled",
        });
        expect(holds.dotypos.cancelReservation.mock.calls).toEqual([
          [requireValue(requireValue(rotated).dotyposReservationId)],
        ]);
        expect(await rowOf(previous.id)).toMatchObject({
          reservationState: "held",
          paymentState: "pending",
        });
      });

      test("refuses an attempt whose reservation ended in its own session", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const attemptId = newAttemptId();
        const request = holdRequest({
          author,
          attemptId,
          sessionId: promoteCheckoutAttemptToSessionId(attemptId),
        });
        await holds.holdForAttempt(request);
        const [held] = await rowsOf(author);
        await postgres.pool.query(
          `update workspace_reservations
              set reservation_state = 'cancelled', reservation_cancelled_at = now()
            where id = $1`,
          [requireValue(held).id]
        );

        const failure = await holds.holdFailure(request);

        expect(failure._tag).toBe("CheckoutAttemptUnavailableError");
        expect(await rowsOf(author)).toHaveLength(1);
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
      });
    });

    describe("for a customer agent", () => {
      const agentOf = (clientId: string, selection: string) => ({
        clientId: customerAgentClientIdSchema.make(clientId),
        selectionKey: agentSelectionKeySchema.make(
          `${selection}-${crypto.randomUUID()}`
        ),
      });

      test("reuses the hold of an identical repeat, anchored at its booking instant", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const agent = agentOf("https://agent.example/client", "selection");
        const sessionId = newSessionId();
        // Whole milliseconds, which Postgres stores exactly.
        const bookedAt = Temporal.Instant.fromEpochMilliseconds(Date.now());
        const first = holdRequest({ author, sessionId, agent, bookedAt });

        const created = await holds.holdForAttempt(first);
        const repeat = await holds.holdForAttempt(
          holdRequest({
            author,
            sessionId,
            agent,
            customer: first.booking.customer,
          })
        );

        const rows = await rowsOf(author);
        expect(rows).toHaveLength(1);
        expect(created).toMatchObject({
          kind: "created",
          reservationId: requireValue(rows[0]).id,
        });
        expect(repeat).toMatchObject({
          kind: "reused",
          reservation: { id: requireValue(rows[0]).id },
          checkoutSessionId: sessionId,
        });
        expect(rows[0]).toMatchObject({
          agentClientId: agent.clientId,
          agentSelectionKey: agent.selectionKey,
        });
        // An agent hold lasts one Pay-state lifetime from its booking instant.
        expect(rows[0]?.reservationHoldExpiresAt).toEqual(
          bookedAt.add({ milliseconds: payStateDefaultTtlMilliseconds })
        );
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
      });

      test("keeps a repeat's reservation whose payment is pending", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const agent = agentOf("https://agent.example/client", "selection");
        const sessionId = newSessionId();
        const first = holdRequest({ author, sessionId, agent });
        await holds.holdForAttempt(first);
        const [held] = await rowsOf(author);
        await setPaymentState(requireValue(held).id, "pending");

        const repeat = await holds.holdForAttempt(
          holdRequest({
            author,
            sessionId,
            agent,
            customer: first.booking.customer,
          })
        );

        expect(repeat).toMatchObject({
          kind: "payment_pending",
          reservation: { id: requireValue(held).id },
          checkoutSessionId: sessionId,
        });
        expect(await rowsOf(author)).toHaveLength(1);
        expect(holds.dotypos.createReservation).toHaveBeenCalledTimes(1);
        expect(holds.dotypos.cancelReservation).not.toHaveBeenCalled();
      });

      test("cancels only the same client's hold in a rotated session before holding a new selection", async () => {
        const author = await newAuthor();
        const otherAuthor = await newAuthor();
        const holds = makeHolds();
        const clientId = "https://agent.example/client";
        const sessionId = newSessionId();
        const customer = syntheticDotyposCustomerId();
        const book = (request: HoldRequest) => holds.holdForAttempt(request);
        const idOf = (hold: Awaited<ReturnType<typeof book>>) =>
          hold.kind === "created" ? hold.reservationId : undefined;

        // The agent session holds a paid booking, so the client's next
        // selection is held in a rotated session.
        const paid = idOf(
          await book(
            holdRequest({
              author,
              sessionId,
              customer,
              agent: agentOf(clientId, "paid"),
            })
          )
        );
        await setPaymentState(requireValue(paid), "paid");
        const rotated = await book(
          holdRequest({
            author,
            sessionId,
            customer,
            agent: agentOf(clientId, "rotated"),
          })
        );
        expect(rotated.kind).toBe("created");
        expect(rotated).not.toMatchObject({ checkoutSessionId: sessionId });
        // Holds the new selection must leave alone: another client's, and
        // the same client's for another account.
        const otherClients = idOf(
          await book(
            holdRequest({
              author,
              customer,
              agent: agentOf("https://other-agent.example/client", "other"),
            })
          )
        );
        const otherAccounts = idOf(
          await book(
            holdRequest({
              author: otherAuthor,
              agent: agentOf(clientId, "other-account"),
            })
          )
        );
        const rotatedRow = await rowOf(requireValue(idOf(rotated)));
        holds.dotypos.cancelReservation.mockClear();

        const next = await book(
          holdRequest({
            author,
            sessionId,
            customer,
            agent: agentOf(clientId, "next"),
          })
        );

        expect(next.kind).toBe("created");
        expect(holds.dotypos.cancelReservation.mock.calls).toEqual([
          [requireValue(requireValue(rotatedRow).dotyposReservationId)],
        ]);
        expect(await rowOf(requireValue(idOf(rotated)))).toMatchObject({
          reservationState: "cancelled",
        });
        for (const kept of [otherClients, otherAccounts]) {
          expect(await rowOf(requireValue(kept))).toMatchObject({
            reservationState: "held",
          });
        }
        expect(await rowOf(requireValue(paid))).toMatchObject({
          reservationState: "held",
          paymentState: "paid",
        });
      });
      test("supersedes the client's previous selection in its session", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const clientId = "https://agent.example/client";
        const sessionId = newSessionId();
        const customer = syntheticDotyposCustomerId();
        await holds.holdForAttempt(
          holdRequest({
            author,
            sessionId,
            customer,
            agent: agentOf(clientId, "previous"),
          })
        );
        const [previous] = await rowsOf(author);

        const hold = await holds.holdForAttempt(
          holdRequest({
            author,
            sessionId,
            customer,
            agent: agentOf(clientId, "next"),
          })
        );

        const replacement = (await rowsOf(author)).find(
          (row) => row.id !== requireValue(previous).id
        );
        expect(hold).toEqual({
          kind: "created",
          reservationId: requireValue(replacement).id,
          checkoutSessionId: sessionId,
          reservationHoldExpiresAt: expect.any(Temporal.Instant),
        });
        expectStoredHoldDeadline(hold, replacement);
        expect(replacement?.checkoutSessionKey).toBe(
          requireValue(previous).checkoutSessionKey
        );
        expect(await rowOf(requireValue(previous).id)).toMatchObject({
          reservationState: "cancelled",
        });
        expect(holds.dotypos.cancelReservation.mock.calls).toEqual([
          [requireValue(requireValue(previous).dotyposReservationId)],
        ]);
      });

      test("holds a new selection when cancelling the client's rotated hold fails", async () => {
        const author = await newAuthor();
        const holds = makeHolds();
        const clientId = "https://agent.example/client";
        const sessionId = newSessionId();
        const customer = syntheticDotyposCustomerId();
        const book = (selection: string) =>
          holds.holdForAttempt(
            holdRequest({
              author,
              sessionId,
              customer,
              agent: agentOf(clientId, selection),
            })
          );
        const paid = await book("paid");
        await setPaymentState(
          paid.kind === "created" ? paid.reservationId : "",
          "paid"
        );
        const rotated = await book("rotated");
        holds.dotypos.cancelReservation.mockImplementationOnce(() =>
          Effect.fail(dotyposUnavailable("cancelReservation"))
        );

        const next = await book("next");

        expect(next.kind).toBe("created");
        expect(
          await rowOf(rotated.kind === "created" ? rotated.reservationId : "")
        ).toMatchObject({
          reservationState: "cancellation_failed",
          failureCode: "checkout_supersession_cancel_failed",
        });
        expect(await rowsOf(author)).toHaveLength(3);
      });
    });
  }
);
