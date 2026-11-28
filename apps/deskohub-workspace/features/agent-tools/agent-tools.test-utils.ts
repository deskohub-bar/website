import {
  type DotyposReservation,
  DotyposReservationIdSchema,
  DotyposService,
  type DotyposTable,
  DotyposTableIdSchema,
  DotyposTableSchema,
} from "@deskohub/dotypos";
import { Effect, Layer, Schema } from "effect";
import {
  CustomerAccountContactService,
  CustomerAccountReservationOwnership,
  CustomerAccountSections,
  CustomerAgentAuthorization,
  type CustomerAgentGrant,
} from "@/features/account";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { CustomerProfileService } from "@/features/account/backend/customer-profile.service";
import { CustomerReservationHistoryService } from "@/features/account/backend/customer-reservation-history.service";
import { CheckoutPricingService } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import { CheckoutStatusService } from "@/features/checkout/backend/checkout/checkout-status.service";
import {
  type DiscountAdvertisementInput,
  discountAdvertisementQuoteCodec,
  discountIdSchema,
} from "@/features/discounts/contracts";
import { DiscountServiceMock } from "@/features/discounts/discount.service.mock";
import { OfficeReleaseGate } from "@/features/office/backend/office-release-gate";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import { ReferralReleaseGate } from "@/features/referrals/referral-release-gate";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { OvernightStayReleaseGate } from "@/features/reservation/backend/overnight-stay-release-gate";
import { ReservationBooking } from "@/features/reservation/backend/reservation-booking.service";
import type { ReservationRecord } from "@/features/reservation/backend/reservation-record";
import { WorkspaceAvailabilityService } from "@/features/reservation/backend/workspace-availability.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { ReservationInvitees } from "@/features/reservation-invitees/backend/reservation-invitees.service";
import { ReviewSandbox } from "@/features/review-accounts/backend/review-sandbox.service";
import {
  getUnclassifiedTeamTableBookings,
  TeamTableInventory,
} from "@/features/team-table/backend/team-table-inventory";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";
import { moneyWithValue } from "@/shared/money/money";
import { TestSealedStateKeys } from "@/shared/testing/sealed-state-keys.test-utils";
import { connectUnreachableWorkspaceDatabase } from "@/shared/testing/unreachable-workspace-database.test-utils";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import {
  CurrentCustomerAgentGrant,
  CustomerAgentCallServices,
} from "./customer-agent-caller";

const decodeTable = Schema.decodeSync(DotyposTableSchema);

const makeTestTable = (input: {
  readonly id: string;
  readonly tags: readonly string[];
  readonly seats?: string;
}): DotyposTable =>
  decodeTable({
    _cloudId: "cloud",
    display: true,
    enabled: true,
    name: input.id,
    seats: input.seats ?? "1",
    id: input.id,
    tags: [...input.tags],
  });

/**
 * The office table's seat capacity. The tools read the office maximum only
 * from this Dotypos table, so a capacity other than the live office's makes a
 * hard-coded maximum fail.
 */
export const agentToolTestOfficeSeats = 4;

/** One Open Space desk, one Reserved Desk, the meeting room, and the office. */
const agentToolTestTables: readonly DotyposTable[] = [
  makeTestTable({ id: "open-1", tags: ["tier:basic", "cowork:open-space"] }),
  makeTestTable({
    id: "desk-1",
    tags: [
      "tier:profi",
      "cowork:reserved-desk",
      "monitor:count:2",
      "monitor:size:27",
      "monitor:resolution:qhd",
    ],
  }),
  makeTestTable({ id: "room-1", tags: ["reservation:meeting-room"] }),
  makeTestTable({
    id: "office-1",
    tags: ["reservation:office"],
    seats: String(agentToolTestOfficeSeats),
  }),
];

/**
 * Checks that a tool's result is what `schema` describes, such as its
 * success result rather than an error result, and narrows it to that.
 */
export const agentToolResultOf =
  <S extends Schema.Constraint>(schema: S) =>
  <I>(result: I): I & S["Type"] => {
    Schema.asserts(schema, result);
    return result;
  };

/**
 * The services the customer agent tools' types name but a test of their
 * public reads never reaches: each one dies when read, and the database has
 * no server behind it.
 */
export const unreadCustomerAgentToolServices = Layer.mergeAll(
  Layer.mock(CheckoutStatusService, {}),
  Layer.mock(CoworkPassesReleaseGate, {}),
  Layer.mock(CustomerAgentAuthorization, {}),
  Layer.mock(CustomerPasses, {}),
  Layer.mock(CustomerReservationHistoryService, {}),
  Layer.mock(ReferralReleaseGate, {}),
  Layer.mock(RememberedReferral, {}),
  Layer.mock(ReservationBooking, {}),
  Layer.mock(ReservationInvitees, {}),
  Layer.mock(ReviewSandbox, {}),
  Layer.mock(WorkspaceReservationRepository, {}),
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.promise(connectUnreachableWorkspaceDatabase),
      ({ pool }) => Effect.promise(() => pool.close())
    ).pipe(Effect.map(({ database }) => database))
  )
);

/** A Prague date `days` after today, as YYYY-MM-DD. */
export const workspaceDateFromToday = (days: number) =>
  getCurrentWorkspaceDate().add({ days }).toString();

/** Today in Prague at a local wall-clock time such as `15:20`. */
export const workspaceInstantToday = (time: string) =>
  getCurrentWorkspaceDate()
    .toZonedDateTime({
      timeZone: workspaceSiteConstants.location.timeZone,
      plainTime: Temporal.PlainTime.from(time),
    })
    .toInstant();

/** A confirmed booking of a table for a whole Prague date. */
export const makeTestOccupancy = (input: {
  readonly tableId: string;
  readonly date: string;
}): ReservationRecord => {
  const { timeZone } = workspaceSiteConstants.location;
  const day = Temporal.PlainDate.from(input.date);

  return {
    id: DotyposReservationIdSchema.make(
      `booking-${input.tableId}-${input.date}`
    ),
    _tableId: DotyposTableIdSchema.make(input.tableId),
    status: "CONFIRMED",
    seats: "1",
    startDate: day.toZonedDateTime(timeZone).toInstant().toString(),
    endDate: day
      .add({ days: 1 })
      .toZonedDateTime(timeZone)
      .toInstant()
      .toString(),
  };
};

const saleDiscountId = Schema.decodeSync(discountIdSchema)("agent-sale");

/**
 * Advertised discounts as Calendar would discover them: none, or a
 * percentage sale on every product.
 */
const discoverTestDiscounts =
  (saleBasisPoints: number | undefined) =>
  ({ product, discountableSubtotal }: DiscountAdvertisementInput) => {
    const amount = saleBasisPoints
      ? Math.round((discountableSubtotal.value * saleBasisPoints) / 10_000)
      : 0;
    const after = moneyWithValue(
      discountableSubtotal.value - amount,
      discountableSubtotal
    );

    return Effect.succeed({
      complete: true,
      quote: discountAdvertisementQuoteCodec.make({
        product,
        discountableSubtotal,
        discounts: amount
          ? [
              {
                discount: {
                  id: saleDiscountId,
                  label: "Agent sale",
                  adjustment: {
                    kind: "percentage",
                    basisPoints: saleBasisPoints ?? 0,
                  },
                },
                subtotalBefore: discountableSubtotal,
                amount: moneyWithValue(amount, discountableSubtotal),
                subtotalAfter: after,
              },
            ]
          : [],
        totalDiscount: moneyWithValue(amount, discountableSubtotal),
        discountedSubtotal: after,
      }),
    });
  };

/**
 * The services agent tools read through. Calls are recorded, and live
 * inventory reads require an explicit fixture.
 */
export const makeAgentToolTestServices = ({
  tables = agentToolTestTables,
  occupancy = [],
  officeEnabled = true,
  teamTableEnabled = false,
  teamTableSizes = [],
  liveReservations,
  saleBasisPoints,
}: {
  readonly tables?: readonly DotyposTable[];
  readonly occupancy?: readonly ReservationRecord[];
  readonly officeEnabled?: boolean;
  readonly teamTableEnabled?: boolean;
  readonly teamTableSizes?: readonly number[];
  readonly liveReservations?: readonly DotyposReservation[];
  readonly saleBasisPoints?: number;
} = {}) => {
  const dotyposRequests: string[] = [];
  const snapshotReads: string[] = [];
  const availableTables = [
    ...tables,
    ...teamTableSizes.map((seats, index) =>
      makeTestTable({
        id: `table-${index}`,
        tags: ["cowork:open-space", "reservation:table"],
        seats: String(seats),
      })
    ),
  ];
  const dotypos = Layer.effect(
    DotyposService,
    Effect.gen(function* () {
      const unimplemented = yield* DotyposService;
      return new Proxy(unimplemented, {
        get: (_target, operation) => () =>
          Effect.suspend(
            (): Effect.Effect<
              readonly (DotyposTable | DotyposReservation)[]
            > => {
              dotyposRequests.push(String(operation));
              if (liveReservations && operation === "getTables") {
                return Effect.succeed(availableTables);
              }
              if (
                liveReservations &&
                operation === "listActiveReservationsOverlapping"
              ) {
                return Effect.succeed(liveReservations);
              }
              return Effect.die(
                new Error(
                  `Agent tools must not call Dotypos ${String(operation)}`
                )
              );
            }
          ),
      });
    })
  ).pipe(Layer.provide(Layer.mock(DotyposService, {})));
  const advisoryInventory = Layer.succeed(AdvisoryAvailabilityInventory, {
    tables: Effect.sync(() => {
      snapshotReads.push("tables");
      return availableTables;
    }),
    listActiveReservationsOverlapping: () =>
      Effect.sync(() => {
        snapshotReads.push("reservations");
        return occupancy;
      }),
    listLimitations: () =>
      Effect.sync(() => {
        snapshotReads.push("limitations");
        return [];
      }),
  });
  const officeFlag = OfficeReleaseGate.fromDecision(officeEnabled);
  const tableGate = TeamTableReleaseGate.fromDecision(teamTableEnabled);

  const layer = Layer.mergeAll(
    WorkspaceAvailabilityService.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          advisoryInventory,
          tableGate,
          Layer.succeed(TeamTableInventory, (records, claims) =>
            Effect.succeed([
              ...getUnclassifiedTeamTableBookings(records, claims),
            ])
          ),
          dotypos,
          Layer.succeed(GoogleCalendarWorkspaceLimitationsService, {
            listLimitations: () => Effect.succeed([]),
          }),
          Layer.mock(WorkspaceReservationRepository, {
            selectLocalTableCapacity: () => Effect.succeed([]),
            selectPendingPassDayCapacity: () => Effect.succeed([]),
            selectExpiredHoldDotyposReservationIds: () => Effect.succeed([]),
          })
        )
      )
    ),
    advisoryInventory,
    CheckoutPricingService.Default.pipe(
      Layer.provide(
        DiscountServiceMock({
          discoverAdvertisedDiscounts: discoverTestDiscounts(saleBasisPoints),
        })
      )
    ),
    officeFlag,
    tableGate,
    OvernightStayReleaseGate.fromDecision(false),
    TestSealedStateKeys
  );

  return { layer, dotyposRequests, snapshotReads };
};

/** Fakes of the account services a signed-in tool reads the customer through. */
type CustomerAgentAccountFakes = {
  readonly authentication?: Layer.PartialEffectful<
    CustomerAuthentication["Service"]
  >;
  readonly sections?: Layer.PartialEffectful<
    CustomerAccountSections["Service"]
  >;
  readonly contact?: Layer.PartialEffectful<
    CustomerAccountContactService["Service"]
  >;
  readonly currentAccount?: Layer.PartialEffectful<
    CurrentCustomerAccount["Service"]
  >;
  readonly profile?: Layer.PartialEffectful<CustomerProfileService["Service"]>;
  readonly ownership?: Layer.PartialEffectful<
    CustomerAccountReservationOwnership["Service"]
  >;
};

/**
 * Signed-in tool calls that read a fixed customer instead of verifying the
 * caller's access token: the caller's grant, and the account services
 * `fakes` builds for it. A read of anything not faked dies, so no call
 * reaches the authorization server or the database.
 */
export const inMemoryCustomerAgentCallServices = (
  fakes: (grant: CustomerAgentGrant) => CustomerAgentAccountFakes = () => ({})
) =>
  Layer.succeed(CustomerAgentCallServices, {
    forCaller: ({ grant }) => {
      const {
        authentication,
        sections,
        contact,
        currentAccount,
        profile,
        ownership,
      } = fakes(grant);

      return Layer.mergeAll(
        Layer.succeed(CurrentCustomerAgentGrant, grant),
        Layer.mock(CustomerAuthentication, authentication ?? {}),
        Layer.mock(CustomerAccountSections, sections ?? {}),
        Layer.mock(CustomerAccountContactService, contact ?? {}),
        Layer.mock(CurrentCustomerAccount, currentAccount ?? {}),
        Layer.mock(CustomerProfileService, profile ?? {}),
        Layer.mock(CustomerAccountReservationOwnership, ownership ?? {})
      );
    },
  });
