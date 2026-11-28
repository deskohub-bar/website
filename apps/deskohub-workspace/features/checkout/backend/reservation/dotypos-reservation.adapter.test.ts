import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposService,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { Effect, Layer, Schema } from "effect";
import {
  getWorkspaceMeetingRoomDurationLabel,
  getWorkspaceMeetingRoomProductTitle,
  getWorkspaceOfficeProductTitle,
  getWorkspaceProductMonitorTitle,
  getWorkspaceProductTierTitle,
} from "@/features/checkout/product-catalog.i18n";
import { checkoutDetailsSchema } from "@/features/checkout/schemas/checkout-details";
import { discountIdSchema } from "@/features/discounts/contracts";
import { type Locale, locales } from "@/features/i18n";
import { dotyposCreatedReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { formatMoney, moneyWithValue } from "@/shared/money/money";
import {
  captureLogAnnotationsWithExit,
  expectScalarLogAnnotations,
} from "@/shared/testing/log-annotations.test-utils";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import {
  createWorkspaceDotyposReservation,
  formatWorkspaceReservationNote,
} from "./dotypos-reservation.adapter";
import { noteNamesPaymentOrder } from "./order-reservation-note";
import {
  type WorkspaceTableAssignmentReservation,
  WorkspaceTableAssignmentService,
} from "./workspace-table-assignment.service";

const paymentOrderId = workspaceReservationIdSchema.make("payment-order-id");
const dotyposCustomerId = DotyposCustomerIdSchema.make("dotypos-customer-id");

const mockReservationCreation = () =>
  mock<typeof DotyposService.Service.createReservation>((input) =>
    Effect.succeed(
      dotyposCreatedReservationFixture("dotypos-reservation-id", input)
    )
  );

const checkoutDetails = Schema.decodeUnknownSync(checkoutDetailsSchema)({
  locale: "en-US",
  reservation: {
    kind: "cowork",
    entryTier: "basic",
    date: "2099-06-10",
    coffee: false,
  },
  payment: {
    expectedPrice: { value: 35_000, exponent: 2, currency: "CZK" },
    undiscountedPrice: { value: 35_000, exponent: 2, currency: "CZK" },
    discounts: [],
    summary: {
      sections: [],
      total: { value: 35_000, exponent: 2, currency: "CZK" },
    },
  },
  legal: {},
});

const makeMeetingRoomCheckoutDetails = (earlySetup: boolean) =>
  Schema.decodeUnknownSync(checkoutDetailsSchema)({
    locale: "en-US",
    reservation: {
      kind: "meeting-room",
      duration: { unit: "hour", amount: 1 },
      reservationDate: "2099-06-10",
      startsAt: "2099-06-10T08:00:00Z",
      endsAt: "2099-06-10T09:00:00Z",
      ...(earlySetup && { earlySetup: true }),
    },
    payment: {
      expectedPrice: { value: 35_000, exponent: 2, currency: "CZK" },
      undiscountedPrice: { value: 35_000, exponent: 2, currency: "CZK" },
      discounts: [],
      items: [
        {
          type: "meeting-room",
          duration: { unit: "hour", amount: 1 },
          amount: { value: 35_000, exponent: 2, currency: "CZK" },
        },
      ],
    },
    legal: {},
  });

const createMeetingRoomDotyposInput = async (earlySetup: boolean) => {
  const details = makeMeetingRoomCheckoutDetails(earlySetup);
  const assignTableId = mock(() =>
    Effect.succeed(DotyposTableIdSchema.make("meeting-room-id"))
  );
  const createReservation = mockReservationCreation();
  const testLayer = Layer.mergeAll(
    Layer.mock(WorkspaceTableAssignmentService, {
      assignTableId,
    }),
    Layer.mock(DotyposService, { createReservation })
  );

  await createWorkspaceDotyposReservation({
    paymentOrderId,
    dotyposCustomerId,
    checkoutDetails: details,
    reservation: details.reservation,
    status: "NEW",
  }).pipe(Effect.provide(testLayer), Effect.runPromise);

  return requireValue(
    createReservation.mock.calls[0],
    "reservation creation call"
  )[0];
};

describe("createWorkspaceDotyposReservation", () => {
  test("uses the cowork reservation domain interval for creation", async () => {
    const reservation = {
      kind: "cowork" as const,
      entryTier: "basic" as const,
      date: "2099-06-10",
      coffee: false,
    };
    const assignTableId = mock(() =>
      Effect.succeed(DotyposTableIdSchema.make("cowork-table-id"))
    );
    const createReservation = mockReservationCreation();
    const testLayer = Layer.mergeAll(
      Layer.mock(WorkspaceTableAssignmentService, {
        assignTableId,
      }),
      Layer.mock(DotyposService, {
        createReservation,
      })
    );

    await createWorkspaceDotyposReservation({
      paymentOrderId,
      dotyposCustomerId,
      checkoutDetails,
      reservation,
      status: "NEW",
    }).pipe(Effect.provide(testLayer), Effect.runPromise);

    expect(assignTableId).toHaveBeenCalledWith(reservation);
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: new Date("2099-06-09T22:00:00Z"),
        endDate: new Date("2099-06-10T22:00:00Z"),
      })
    );
  });

  test("creates an overnight Reserved Desk from noon on the arrival date to noon the next day", async () => {
    const reservation = {
      kind: "cowork" as const,
      entryTier: "reserved-desk" as const,
      date: "2099-06-10",
      coffee: true as const,
      stay: "overnight" as const,
    };
    const assignTableId = mock(() =>
      Effect.succeed(DotyposTableIdSchema.make("cowork-table-id"))
    );
    const createReservation = mockReservationCreation();

    await createWorkspaceDotyposReservation({
      paymentOrderId,
      dotyposCustomerId,
      checkoutDetails,
      reservation,
      status: "NEW",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(WorkspaceTableAssignmentService, {
            assignTableId,
          }),
          Layer.mock(DotyposService, { createReservation })
        )
      ),
      Effect.runPromise
    );

    expect(assignTableId).toHaveBeenCalledWith(reservation);
    // Prague summer time (UTC+2): 12:00 on 2099-06-10 to 12:00 on 2099-06-11.
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: new Date("2099-06-10T10:00:00Z"),
        endDate: new Date("2099-06-11T10:00:00Z"),
      })
    );
  });

  test("annotates its rows with the created reservation's id and status, never a record", async () => {
    const testLayer = Layer.mergeAll(
      Layer.mock(WorkspaceTableAssignmentService, {
        assignTableId: () =>
          Effect.succeed(DotyposTableIdSchema.make("cowork-table-id")),
      }),
      Layer.mock(DotyposService, {
        createReservation: mockReservationCreation(),
      })
    );

    const { rows, exit } = await createWorkspaceDotyposReservation({
      paymentOrderId,
      dotyposCustomerId,
      checkoutDetails,
      reservation: checkoutDetails.reservation,
      status: "NEW",
    }).pipe(
      Effect.provide(testLayer),
      captureLogAnnotationsWithExit,
      Effect.runPromise
    );

    expect(exit._tag).toBe("Success");
    expectScalarLogAnnotations(rows);
    expect(rows).toContainEqual(
      expect.objectContaining({
        dotyposReservationId: "dotypos-reservation-id",
        dotyposReservationStatus: "NEW",
      })
    );
  });

  test("creates an early-setup meeting-room reservation from 15 minutes before its start", async () => {
    const input = await createMeetingRoomDotyposInput(true);

    expect(input.startDate).toEqual(new Date("2099-06-10T07:45:00Z"));
    expect(input.endDate).toEqual(new Date("2099-06-10T09:00:00Z"));
    expect(input.note.split("\n").some((line) => line.endsWith("09:45"))).toBe(
      true
    );
  });

  test("keeps a meeting-room reservation start unchanged without early setup", async () => {
    const input = await createMeetingRoomDotyposInput(false);

    expect(input.startDate).toEqual(new Date("2099-06-10T08:00:00Z"));
    expect(input.endDate).toEqual(new Date("2099-06-10T09:00:00Z"));
    expect(input.note.split("\n").some((line) => line.endsWith("09:45"))).toBe(
      false
    );
  });
});

const summerSale = {
  discount: {
    id: Schema.decodeUnknownSync(discountIdSchema)("summer-sale"),
    label: "Letní sleva",
    adjustment: { kind: "percentage" as const, basisPoints: 1000 },
  },
  subtotalBefore: { value: 35_000, exponent: 2, currency: "CZK" },
  amount: { value: 3500, exponent: 2, currency: "CZK" },
  subtotalAfter: { value: 31_500, exponent: 2, currency: "CZK" },
};

const meetingRoomDuration = { unit: "hour" as const, amount: 2 as const };

const noteReservations = {
  cowork: {
    kind: "cowork",
    entryTier: "profi",
    date: "2099-06-10",
    coffee: true,
    monitorOption: "2x27-4k",
  },
  "meeting-room": {
    kind: "meeting-room",
    duration: meetingRoomDuration,
    reservationDate: "2099-06-10",
    startsAt: "2099-06-10T08:00:00Z",
    endsAt: "2099-06-10T10:00:00Z",
    earlySetup: true,
  },
  office: {
    kind: "office",
    startsOn: "2099-06-10",
    endsOn: "2099-06-12",
    seats: 3,
  },
} satisfies Record<
  WorkspaceTableAssignmentReservation["kind"],
  WorkspaceTableAssignmentReservation
>;

const formatNote = (
  locale: Locale,
  reservation: WorkspaceTableAssignmentReservation
) =>
  formatWorkspaceReservationNote({
    paymentOrderId,
    reservation,
    checkoutDetails: {
      ...checkoutDetails,
      locale,
      payment: { ...checkoutDetails.payment, discounts: [summerSale] },
    },
  });

describe("formatWorkspaceReservationNote", () => {
  test.each(Object.values(noteReservations))(
    "writes the same $kind note for staff whatever the checkout locale",
    (reservation) => {
      const staffNote = formatNote("cs-CZ", reservation);

      for (const locale of locales) {
        expect(formatNote(locale, reservation)).toBe(staffNote);
      }
    }
  );

  test("names products, durations and amounts in Czech for an English checkout", () => {
    const coworkNote = formatNote("en-US", noteReservations.cowork);
    const meetingRoomNote = formatNote(
      "en-US",
      noteReservations["meeting-room"]
    );
    const officeNote = formatNote("en-US", noteReservations.office);

    expect(coworkNote).toContain(
      getWorkspaceProductTierTitle("profi", "cs-CZ")
    );
    expect(coworkNote).toContain(
      getWorkspaceProductMonitorTitle("2x27-4k", "cs-CZ")
    );
    expect(meetingRoomNote).toContain(
      getWorkspaceMeetingRoomProductTitle("cs-CZ")
    );
    expect(meetingRoomNote).toContain(
      getWorkspaceMeetingRoomDurationLabel(meetingRoomDuration, "cs-CZ")
    );
    expect(officeNote).toContain(getWorkspaceOfficeProductTitle("cs-CZ"));
    expect(officeNote).toContain(
      formatMoney(checkoutDetails.payment.expectedPrice, "cs-CZ")
    );
    expect(officeNote).toContain(
      formatMoney(moneyWithValue(-3500, summerSale.amount), "cs-CZ")
    );
  });

  test("names the discount by its staff label for a non-Czech checkout", () => {
    const germanSale = {
      ...summerSale,
      discount: {
        ...summerSale.discount,
        label: "Sommerrabatt",
        staffLabel: "Letní sleva",
      },
    };
    const note = formatWorkspaceReservationNote({
      paymentOrderId,
      reservation: noteReservations.office,
      checkoutDetails: {
        ...checkoutDetails,
        locale: "de-DE",
        payment: { ...checkoutDetails.payment, discounts: [germanSale] },
      },
    });

    expect(note).toContain(germanSale.discount.staffLabel);
    expect(note).not.toContain(germanSale.discount.label);
  });

  test("names the discount by its checkout label when an older snapshot has no staff label", () => {
    const note = formatNote("en-US", noteReservations.office);

    expect(summerSale.discount).not.toHaveProperty("staffLabel");
    expect(note).toContain(summerSale.discount.label);
  });

  test("lets late-payment recovery find a note by its payment order", () => {
    const note = formatNote("en-US", noteReservations.office);

    expect(noteNamesPaymentOrder(note, paymentOrderId)).toBe(true);
    expect(
      noteNamesPaymentOrder(
        note,
        workspaceReservationIdSchema.make("other-payment-order-id")
      )
    ).toBe(false);
    expect(noteNamesPaymentOrder(undefined, paymentOrderId)).toBe(false);
    expect(noteNamesPaymentOrder(null, paymentOrderId)).toBe(false);
  });

  test("finds notes written before staff notes were Czech", () => {
    expect(
      noteNamesPaymentOrder(
        "Booked online\nPayment order: payment-order-id",
        paymentOrderId
      )
    ).toBe(true);
  });
});
