import { describe, expect, test } from "bun:test";
import { Context, Option, Schema } from "effect";
import { HttpApi, type HttpApiGroup, OpenApi } from "effect/http-api";
import { CustomerBookingSelection } from "./customer-booking-selection";
import {
  CustomerBookedSelection,
  CustomerInvitedReservation,
  CustomerReservationAccess,
  CustomerReservationInvitee,
  CustomerReservationOrderId,
  CustomerReservationPeople,
  CustomerReservationProduct,
} from "./customer-reservations-api";
import {
  CustomerRequestOriginCheck,
  CustomerSessionAuthentication,
} from "./customer-session";
import { CustomerTeamTableSelection } from "./customer-team-table-selection";
import {
  customerApiPathPrefix,
  WorkspaceCustomerApi,
  WorkspaceCustomerApiWithTeamTable,
} from "./workspace-customer-api";

/**
 * Released mobile builds decode every customer endpoint as it was when each
 * build shipped, so the OpenAPI document recorded here may only change on
 * purpose. Regenerate it with
 * `UPDATE_OPENAPI=1 bun test src/workspace-customer-api.test.ts` and review
 * the diff. The test writes the fixture in Biome's format.
 *
 * A shipped build fails to decode a response variant, status or reason it
 * doesn't know, so adding one is a breaking change: keep what shipped builds
 * decode, or serve the change under a new API version.
 */
const fixture = new URL(
  "./workspace-customer-api.openapi.golden.json",
  import.meta.url
);

const endpointsOf = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
) => {
  const endpoints: Array<{
    readonly reference: string;
    readonly group: string;
    readonly path: string;
    readonly middleware: ReadonlyArray<string>;
    readonly payloadParseOptions: Option.Option<unknown>;
  }> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint, middleware, mergedAnnotations }) => {
      endpoints.push({
        reference: `${group.identifier}.${endpoint.identifier}`,
        group: group.identifier,
        path: endpoint.path,
        middleware: [...middleware].map((service) => service.key),
        payloadParseOptions: Context.getOption(
          mergedAnnotations,
          HttpApi.PayloadParseOptions
        ),
      });
    },
  });
  return endpoints;
};

describe("WorkspaceCustomerApi", () => {
  const endpoints = endpointsOf(WorkspaceCustomerApiWithTeamTable);

  test("keeps Team Table discovery and checkout out of the legacy booking contract", () => {
    const legacy = endpointsOf(WorkspaceCustomerApi).map(({ path }) => path);
    expect(legacy).toContain(`${customerApiPathPrefix}/booking/offerings`);
    expect(legacy.some((path) => path.includes("team-table"))).toBe(false);
    expect(
      endpoints
        .filter(({ group }) => group === "teamTable")
        .map(({ path }) => path)
    ).toEqual([
      "/api/customer/booking/team-table/offerings",
      "/api/customer/booking/team-table/availability",
      "/api/customer/booking/team-table/slots",
      "/api/customer/booking/team-table/quote",
      "/api/customer/booking/team-table/checkouts",
      "/api/customer/reservations/:orderId/team-table/status",
      "/api/customer/reservations/:orderId/invitations",
    ]);
  });

  test("carries Team Table details on the legacy-decodable history product", () => {
    const product = {
      kind: "other",
      family: "table",
      teamTable: { kind: "table", seats: 4, durationMinutes: 75 },
    } as const;
    const legacyOther = Schema.Struct({ kind: Schema.Literal("other") });
    const wire = Schema.encodeSync(CustomerReservationProduct)(product);
    expect(Schema.decodeUnknownSync(legacyOther)(wire)).toEqual({
      kind: "other",
    });
    expect(Schema.decodeUnknownSync(CustomerReservationProduct)(wire)).toEqual(
      product
    );
  });

  test("keeps Team Table invitations readable without the optional metadata", () => {
    const legacyOther = Schema.Struct({ kind: Schema.Literal("other") });
    const legacyAccess = Schema.Struct({
      code: CustomerReservationAccess.fields.code,
      accessStartsAt: CustomerReservationAccess.fields.accessStartsAt,
      accessEndsAt: CustomerReservationAccess.fields.accessEndsAt,
    });
    const legacyInvitation = Schema.Struct({
      ...CustomerInvitedReservation.fields,
      product: legacyOther,
      todayAccess: Schema.optional(legacyAccess),
    });
    const accessStartsAt = "2027-01-20T10:15:00Z";
    const accessEndsAt = "2027-01-20T11:15:00Z";
    const legacy = {
      orderId: CustomerReservationOrderId.make("synthetic-team-table-order"),
      product: { kind: "other" },
      productName: "Team Table",
      status: "confirmed",
      accessStartsAt,
      accessEndsAt,
      bookedBy: { name: "Synthetic Booker" },
      todayAccess: { code: "123456", accessStartsAt, accessEndsAt },
    } as const;
    const invitation = {
      ...legacy,
      product: {
        ...legacy.product,
        family: "table",
        teamTable: { kind: "table", seats: 3, durationMinutes: 60 },
      },
      todayAccess: { ...legacy.todayAccess, tableName: "Team Table 12" },
    } as const;
    const wire = Schema.encodeSync(CustomerInvitedReservation)(invitation);
    expect(Schema.decodeUnknownSync(legacyInvitation)(wire)).toEqual(legacy);
    expect(Schema.decodeUnknownSync(CustomerInvitedReservation)(wire)).toEqual(
      invitation
    );
  });

  test("accepts exact quarter-hour Team Table selections across midnight", () => {
    const selection = {
      family: "table",
      date: "2026-12-01",
      startTime: "23:45",
      endTime: "00:15",
      seats: 4,
    } as const;
    const decode = Schema.decodeUnknownSync(CustomerTeamTableSelection);
    expect(decode(selection)).toEqual(selection);
    expect(() => decode({ ...selection, endTime: "00:20" })).toThrow();
    expect(() => decode({ ...selection, seats: 0 })).toThrow();
  });

  test("accepts Entry funding on booking input and keeps the legacy record selection", () => {
    const selection = {
      family: "cowork",
      date: "2026-11-25",
      tier: "reserved-desk",
    } as const;
    const funded = {
      ...selection,
      funding: {
        kind: "entry",
        passId: "019acbf0-0000-7000-8000-000000000011",
      },
    } as const;
    expect(Schema.decodeUnknownSync(CustomerBookingSelection)(funded)).toEqual(
      funded
    );
    expect(
      Schema.decodeUnknownSync(CustomerBookedSelection)({ selection: funded })
    ).toEqual({ selection });
  });

  test("declares every customer API group", () => {
    expect(Object.keys(WorkspaceCustomerApi.groups).sort()).toEqual([
      "account",
      "booking",
      "companies",
      "invoices",
      "passes",
      "reservations",
    ]);
  });

  test("serves every endpoint under its group's customer API prefix", () => {
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpointsOf(WorkspaceCustomerApi)) {
      expect({
        reference: endpoint.reference,
        underGroupPrefix:
          endpoint.path === `${customerApiPathPrefix}/${endpoint.group}` ||
          endpoint.path.startsWith(
            `${customerApiPathPrefix}/${endpoint.group}/`
          ),
      }).toEqual({ reference: endpoint.reference, underGroupPrefix: true });
    }
  });

  // The account and checkout mutations refuse fields they don't know and
  // report every issue, on the server and in the typed client.
  test("decodes exactly the customer input payloads strictly", () => {
    const strict = endpoints.filter(({ payloadParseOptions }) =>
      Option.isSome(payloadParseOptions)
    );

    expect(
      strict.map(({ reference, payloadParseOptions }) => ({
        reference,
        options: Option.getOrUndefined(payloadParseOptions),
      }))
    ).toEqual(
      [
        "account.updateProfile",
        "account.updateLocale",
        "account.completeProfile",
        "account.saveMarketingPreferences",
        "account.syncAnalyticsConsent",
        "account.saveAnalyticsPreference",
        "account.requestDeletion",
        "reservations.reopenPaymentPage",
        "reservations.retryPayment",
        "reservations.withdrawFromReservation",
        "booking.createCheckout",
        "booking.applyCheckoutDiscountCode",
        "booking.clearCheckoutDiscountCode",
        "booking.acceptCheckoutPriceChange",
        "booking.submitCheckout",
        "passes.beginPassPurchase",
        "passes.submitPassPurchase",
        "passes.updatePassPurchasePrice",
        "teamTable.createCheckout",
        "teamTable.addInvitees",
      ].map((reference) => ({
        reference,
        options: { errors: "all", onExcessProperty: "error" },
      }))
    );
  });

  // HttpApiBuilder wraps the handler in each middleware in insertion order,
  // so the last one added runs first: the origin check refuses a cross-site
  // request before the session lookup spends anything.
  test("runs the origin check before session authentication on every endpoint", () => {
    for (const endpoint of endpoints) {
      expect({
        reference: endpoint.reference,
        middleware: endpoint.middleware,
      }).toEqual({
        reference: endpoint.reference,
        middleware: [
          CustomerSessionAuthentication.key,
          CustomerRequestOriginCheck.key,
        ],
      });
    }
  });

  test("keeps the office people payload compatible with clients on either side of resend eligibility", () => {
    const legacyPeople = { contactAttends: true, invitees: [] };
    const activePeople = { ...legacyPeople, resendable: false };
    const legacyContract = Schema.Struct({
      contactAttends: Schema.Boolean,
      invitees: Schema.Array(CustomerReservationInvitee),
    });

    expect(
      Schema.decodeUnknownSync(CustomerReservationPeople)(legacyPeople)
    ).toEqual(legacyPeople);
    expect(
      Schema.decodeUnknownSync(CustomerReservationPeople)(activePeople)
    ).toEqual(activePeople);
    expect(Schema.decodeUnknownSync(legacyContract)(activePeople)).toEqual(
      legacyPeople
    );
  });

  test("keeps its recorded OpenAPI document", async () => {
    const current = OpenApi.fromApi(WorkspaceCustomerApiWithTeamTable);
    if (process.env.UPDATE_OPENAPI === "1") {
      await Bun.write(fixture, `${JSON.stringify(current, null, 2)}\n`);
      // Biome lints the fixture, so write it in Biome's committed form.
      const formatted = Bun.spawnSync(
        ["bun", "x", "biome", "format", "--write", fixture.pathname],
        { cwd: new URL("../../..", import.meta.url).pathname }
      );
      expect(formatted.exitCode).toBe(0);
    }
    const recorded = await Bun.file(fixture).json();

    expect(JSON.parse(JSON.stringify(current))).toEqual(recorded);
  });
});
