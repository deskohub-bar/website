import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import {
  DotyposCustomerIdSchema,
  DotyposReservationIdSchema,
} from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Schema } from "effect";
import {
  companyRegistrationIdSchema,
  vatRegistrationIdSchema,
} from "@/features/accounting/billing-identity";
import type { PreparedCustomerQuote } from "@/features/checkout/backend/checkout/checkout-pricing.service";
import {
  buildCoworkReservationQuote,
  type CoworkReservationQuoteOrder,
} from "@/features/checkout/checkout-quote.test-utils";
import { getReservationQuoteFingerprint } from "@/features/checkout/reservation-quote-fingerprint";
import { getMeetingRoomReservationQuote } from "@/features/checkout/reservation-quote-meeting-room";
import { buildOfficeReservationQuote } from "@/features/checkout/reservation-quote-office";
import { normalizedCoworkReservationOrderSchema } from "@/features/reservation/cowork-reservation";
import { normalizedMeetingRoomReservationOrderSchema } from "@/features/reservation/meeting-room-reservation";
import { normalizedOfficeReservationOrderSchema } from "@/features/reservation/office-reservation";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { moneyWithValue } from "@/shared/money/money";
import {
  instantStringSchema,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import {
  accountingDocumentIdentitySchema,
  accountingDocumentSnapshotSchema,
  decodeStoredAccountingDocumentSnapshot,
  encodeStoredAccountingDocumentSnapshot,
  getAccountingDocumentSnapshotFirstServiceDate,
  makeAccountingDocumentSnapshot,
} from "./accounting-document-snapshot";

const adaEmail = testEmailAddress("ada");

const coworkOrder = {
  entryTier: "basic",
  coffee: true,
} satisfies CoworkReservationQuoteOrder;

const prepared: PreparedCustomerQuote = {
  kind: "cowork",
  reservation: Schema.decodeUnknownSync(normalizedCoworkReservationOrderSchema)(
    {
      kind: "cowork",
      ...coworkOrder,
      date: "2099-01-01",
      name: "Ada Lovelace",
      email: adaEmail,
      phone: "+420 777 777 777",
    }
  ),
  quote: buildCoworkReservationQuote(coworkOrder),
};

const makeSnapshot = () =>
  makeAccountingDocumentSnapshot({
    workspaceReservationId: workspaceReservationIdSchema.make("reservation-id"),
    dotyposReservationId: DotyposReservationIdSchema.make(
      "dotypos-reservation-id"
    ),
    dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
    locale: "en-US",
    prepared,
  });

const officeReservation = normalizedOfficeReservationOrderSchema.make({
  kind: "office",
  startsOn: "2099-06-20",
  endsOn: "2099-06-21",
  seats: 3,
  name: "Ada Lovelace",
  email: adaEmail,
  phone: "+420 777 777 777",
});

const officePrepared: PreparedCustomerQuote = {
  kind: "office",
  reservation: officeReservation,
  quote: Effect.runSync(buildOfficeReservationQuote(officeReservation)),
};

describe("accounting document snapshot", () => {
  test("freezes supplier, buyer, reservation, and accepted quote facts", () => {
    expect(makeSnapshot()).toMatchObject({
      workspaceReservationId:
        workspaceReservationIdSchema.make("reservation-id"),
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      locale: "en-US",
      supplier: {
        legalName: "Desktechub s.r.o.",
        companyId: companyRegistrationIdSchema.make("24531596"),
        vatStatus: "not-vat-payer",
      },
      buyer: {
        kind: "person",
        legalName: "Ada Lovelace",
      },
      delivery: {
        email: adaEmail,
      },
      reservation: {
        kind: "cowork",
        date: "2099-01-01",
      },
      quote: prepared.quote,
    });
  });

  test("freezes only the reservation email needed for invoice delivery", () => {
    const serialized = JSON.stringify(makeSnapshot());

    expect(serialized).toContain(adaEmail);
    expect(serialized).not.toContain("+420 777 777 777");
    expect(serialized).not.toContain('"message"');
  });

  test("freezes office reservation and accepted quote facts", async () => {
    const snapshot = makeAccountingDocumentSnapshot({
      workspaceReservationId: workspaceReservationIdSchema.make(
        "office-reservation-id"
      ),
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-office-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      locale: "en-US",
      prepared: officePrepared,
    });

    expect(snapshot).toMatchObject({
      reservation: {
        kind: "office",
        startsOn: "2099-06-20",
        endsOn: "2099-06-21",
        seats: 3,
      },
      quote: officePrepared.quote,
    });
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(accountingDocumentSnapshotSchema, {
          onExcessProperty: "error",
        })(snapshot)
      )
    ).resolves.toEqual(snapshot);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain(adaEmail);
    expect(serialized).not.toContain("+420 777 777 777");
  });

  test("reads the Prague start date of every reservation family", () => {
    const baseMeetingRoomReservation =
      normalizedMeetingRoomReservationOrderSchema.make({
        kind: "meeting-room",
        duration: { unit: "hour", amount: 4 },
        reservationDate: plainDateStringSchema.make("2099-02-03"),
        startsAt: instantStringSchema.make("2099-02-03T08:00:00Z"),
        endsAt: instantStringSchema.make("2099-02-03T12:00:00Z"),
        name: "Ada Lovelace",
        email: adaEmail,
        phone: "+420 777 777 777",
      });
    const baseMeetingRoomQuote = Effect.runSync(
      getMeetingRoomReservationQuote(baseMeetingRoomReservation)
    );
    const baseMeetingRoomSnapshot = makeAccountingDocumentSnapshot({
      workspaceReservationId:
        workspaceReservationIdSchema.make("reservation-id"),
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      locale: "en-US",
      prepared: {
        kind: "meeting-room",
        reservation: baseMeetingRoomReservation,
        quote: {
          ...baseMeetingRoomQuote,
          fingerprint: getReservationQuoteFingerprint(
            baseMeetingRoomReservation,
            baseMeetingRoomQuote
          ),
        },
      },
    });
    const makeMeetingRoomSnapshot = (startsAt: string, endsAt: string) =>
      Schema.decodeUnknownSync(accountingDocumentSnapshotSchema)({
        ...baseMeetingRoomSnapshot,
        reservation: {
          kind: "meeting-room",
          startsAt: instantStringSchema.make(startsAt),
          endsAt: instantStringSchema.make(endsAt),
        },
      });
    // 00:30 in Prague on June 21, still June 20 in UTC.
    const meetingRoomSnapshot = makeMeetingRoomSnapshot(
      "2099-06-20T22:30:00Z",
      "2099-06-21T00:30:00Z"
    );
    const overnightMeetingRoomSnapshot = makeMeetingRoomSnapshot(
      "2099-06-20T20:00:00Z",
      "2099-06-20T23:00:00Z"
    );
    const officeSnapshot = makeAccountingDocumentSnapshot({
      workspaceReservationId:
        workspaceReservationIdSchema.make("reservation-id"),
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      locale: "en-US",
      prepared: officePrepared,
    });

    expect(getAccountingDocumentSnapshotFirstServiceDate(makeSnapshot())).toBe(
      "2099-01-01"
    );
    expect(
      getAccountingDocumentSnapshotFirstServiceDate(meetingRoomSnapshot)
    ).toBe("2099-06-21");
    expect(
      getAccountingDocumentSnapshotFirstServiceDate(
        overnightMeetingRoomSnapshot
      )
    ).toBe("2099-06-20");
    expect(getAccountingDocumentSnapshotFirstServiceDate(officeSnapshot)).toBe(
      "2099-06-20"
    );
  });

  test("supports a reservation-specific business billing identity", () => {
    const buyer = {
      kind: "business" as const,
      legalName: "Analytical Engines s.r.o.",
      companyId: companyRegistrationIdSchema.make("12345678"),
      vatId: vatRegistrationIdSchema.make("CZ12345678"),
      address: {
        line1: "Počernická 1",
        city: "Praha",
        postalCode: "100 00",
        country: "CZ",
      },
    };
    const snapshot = makeAccountingDocumentSnapshot({
      workspaceReservationId: workspaceReservationIdSchema.make(
        "business-reservation"
      ),
      dotyposReservationId: DotyposReservationIdSchema.make(
        "dotypos-reservation-id"
      ),
      dotyposCustomerId: DotyposCustomerIdSchema.make("dotypos-customer-id"),
      locale: "cs-CZ",
      prepared: {
        ...prepared,
        reservation: {
          ...prepared.reservation,
          billing: { purpose: "business", invoice: "required", buyer },
        },
      },
    });

    expect(snapshot.buyer).toEqual(buyer);
  });

  test("decodes historical snapshots without an invoice instruction", async () => {
    const { billing: _billing, ...historicalSnapshot } = makeSnapshot();

    const decoded = await Effect.runPromise(
      decodeStoredAccountingDocumentSnapshot(historicalSnapshot)
    );

    expect(decoded.billing).toBeUndefined();
  });

  test.each(["not-vat-payer", "vat-payer"] as const)(
    "decodes a stored snapshot issued as %s with that VAT status",
    async (vatStatus) => {
      const snapshot = makeSnapshot();
      const stored = encodeStoredAccountingDocumentSnapshot({
        ...snapshot,
        supplier: { ...snapshot.supplier, vatStatus },
      });

      const decoded = await Effect.runPromise(
        decodeStoredAccountingDocumentSnapshot(stored)
      );

      expect(decoded.supplier.vatStatus).toBe(vatStatus);
    }
  );

  test("rejects a stored snapshot with an unknown VAT status", async () => {
    const snapshot = makeSnapshot();

    await expect(
      Effect.runPromise(
        decodeStoredAccountingDocumentSnapshot({
          ...snapshot,
          supplier: { ...snapshot.supplier, vatStatus: "exempt" },
        })
      )
    ).rejects.toBeDefined();
  });

  test("decodes discounts with and without a staff label", async () => {
    const snapshot = makeSnapshot();
    const price = snapshot.quote.payment.expectedPrice;
    const withDiscount = (discount: {
      label: string;
      staffLabel?: string;
    }) => ({
      ...snapshot,
      quote: {
        ...snapshot.quote,
        payment: {
          ...snapshot.quote.payment,
          discounts: [
            {
              discount: {
                id: "summer-sale",
                adjustment: { kind: "percentage", basisPoints: 1000 },
                ...discount,
              },
              subtotalBefore: price,
              amount: moneyWithValue(1, price),
              subtotalAfter: moneyWithValue(price.value - 1, price),
            },
          ],
        },
      },
    });

    const historical = await Effect.runPromise(
      decodeStoredAccountingDocumentSnapshot(
        withDiscount({ label: "Sommerrabatt" })
      )
    );
    const current = await Effect.runPromise(
      decodeStoredAccountingDocumentSnapshot(
        withDiscount({ label: "Sommerrabatt", staffLabel: "Letní sleva" })
      )
    );

    expect(historical.quote.payment.discounts[0]?.discount).not.toHaveProperty(
      "staffLabel"
    );
    expect(current.quote.payment.discounts[0]?.discount.staffLabel).toBe(
      "Letní sleva"
    );
  });

  test("rejects schema-version metadata from stored snapshots", async () => {
    const snapshot = makeSnapshot();

    await expect(
      Effect.runPromise(
        decodeStoredAccountingDocumentSnapshot({
          ...snapshot,
          schemaVersion: 1,
        })
      )
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        decodeStoredAccountingDocumentSnapshot({
          ...snapshot,
          unexpected: true,
        })
      )
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        decodeStoredAccountingDocumentSnapshot({
          ...snapshot,
          schemaVersion: 2,
        })
      )
    ).rejects.toBeDefined();
  });
});

test("keeps a document only in a language Workspace serves", () => {
  const decodeLocale = Schema.decodeUnknownSync(
    accountingDocumentIdentitySchema.fields.locale
  );
  expect(decodeLocale("cs-CZ")).toBe("cs-CZ");
  expect(decodeLocale("en-US")).toBe("en-US");
  expect(() => decodeLocale("zz-ZZ")).toThrow();
});
