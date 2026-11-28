import { describe, expect, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  type Customer as DotyposCustomer,
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  DotyposService,
  DotyposUnavailable,
} from "@deskohub/dotypos";
import { GoogleCalendarService } from "@deskohub/google-calendar";
import { testEmailAddress } from "@deskohub/test-email";
import { AdministrationCustomerSearchResult } from "@deskohub/workspace-admin-api";
import { Effect, Layer, Option, Schema } from "effect";
import type { WorkspaceDatabase } from "@/db/database.service";
import { AdministrationCustomerDirectory } from "@/features/administration/customer-directory.service";
import { inactiveCustomerDisplayNames } from "@/features/administration/customer-name";
import {
  CalendarResourceConfig,
  salesCalendarIdSchema,
  workspaceLimitationsCalendarIdSchema,
} from "@/shared/backend/config/calendar-resource.config";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";
import { discountCodeIdSchema } from "../persistence-contracts";
import {
  getAdminDiscountCodeUsage,
  makeDiscountAdministrationReads,
  toAdminDotyposCustomer,
} from "./discount-administration-reads";

describe("discount administration read models", () => {
  test("counts reserved and redeemed claims against capacity but excludes releases", () => {
    expect(
      getAdminDiscountCodeUsage({
        maxUses: 5,
        states: ["reserved", "redeemed", "released", "released"],
      })
    ).toEqual({
      reservedUses: 1,
      redeemedUses: 1,
      releasedUses: 2,
      remainingUses: 3,
    });
  });

  test("keeps unlimited capacity and floors exhausted codes at zero", () => {
    expect(
      getAdminDiscountCodeUsage({
        maxUses: null,
        states: ["redeemed"],
      }).remainingUses
    ).toBeNull();
    expect(
      getAdminDiscountCodeUsage({
        maxUses: 1,
        states: ["reserved", "redeemed"],
      }).remainingUses
    ).toBe(0);
  });
});

const customerDefaults = {
  _cloudId: DotyposCloudIdSchema.make("cloud-synthetic"),
  points: null,
  flags: "0",
  display: true,
  deleted: false,
};

describe("discount administration customers", () => {
  const unnamed: DotyposCustomer = {
    ...customerDefaults,
    id: DotyposCustomerIdSchema.make("dotypos-customer"),
  };
  const now = new Date("2026-11-17T12:00:00Z");
  const former: DotyposCustomer = {
    ...customerDefaults,
    id: DotyposCustomerIdSchema.make("dotypos-customer"),
    firstName: "Synthetic",
    lastName: "Former",
    email: testEmailAddress("discount-former"),
    phone: "+420 123 456 789",
  };

  test("signals a customer without a name or contact detail", () => {
    expect(toAdminDotyposCustomer(unnamed, now)).toMatchObject({
      displayName: "Unnamed customer",
      hasName: false,
    });
    expect(
      toAdminDotyposCustomer({ ...unnamed, phone: " +420 123 456 789 " }, now)
    ).toMatchObject({ displayName: "+420 123 456 789", hasName: true });
  });

  test("keeps the administration API customer shape unchanged", () => {
    const encoded = Schema.encodeSync(AdministrationCustomerSearchResult)({
      kind: "matched",
      customers: [toAdminDotyposCustomer(unnamed, now)],
    });

    expect(encoded.customers[0]).toEqual({
      id: "dotypos-customer",
      displayName: "Unnamed customer",
      email: null,
      phone: null,
      discountGroupId: null,
    });
  });

  test.each([
    ["deleted", { deleted: true }],
    ["expired", { expireDate: "2020-01-01T00:00:00Z" }],
  ] as const)(
    "carries a %s customer's placeholder on the unchanged API shape, without contact details",
    (lifecycle, fields) => {
      const customer = toAdminDotyposCustomer({ ...former, ...fields }, now);
      expect(customer).toMatchObject({
        displayName: inactiveCustomerDisplayNames[lifecycle],
        hasName: false,
        lifecycle,
        email: null,
        phone: null,
      });
      expect(
        Schema.encodeSync(AdministrationCustomerSearchResult)({
          kind: "matched",
          customers: [customer],
        }).customers[0]
      ).toEqual({
        id: "dotypos-customer",
        displayName: inactiveCustomerDisplayNames[lifecycle],
        email: null,
        phone: null,
        discountGroupId: null,
      });
    }
  );
});

/** The reads over a substituted Dotypos and database; the directory is the real one. */
const readsLayer = (
  database: Layer.Layer<WorkspaceDatabase>,
  dotypos: Layer.Layer<DotyposService>
) =>
  Layer.mergeAll(
    database,
    AdministrationCustomerDirectory.Default.pipe(Layer.provide(dotypos)),
    dotypos,
    Layer.mock(GoogleCalendarService, {}),
    Layer.mock(CalendarResourceConfig, {
      salesCalendarId: salesCalendarIdSchema.make("sales-calendar"),
      workspaceLimitationsCalendarId: workspaceLimitationsCalendarIdSchema.make(
        "limitations-calendar"
      ),
    })
  );

describe("discount administration audiences", () => {
  test("lists audience customers in audience order when the batch read fails", async () => {
    const codeId = discountCodeIdSchema.make("code");
    const promotionCodeId = "promotion";
    const discountId = "discount";
    const timestamp = "2026-11-17T12:00:00Z";
    const audience = ["failing", "deleted", "expired", "active", "missing"].map(
      (id) => ({
        promotionCodeId,
        dotyposCustomerId: DotyposCustomerIdSchema.make(id),
      })
    );
    const customers = new Map<DotyposCustomerId, DotyposCustomer>(
      (
        [
          {
            ...customerDefaults,
            id: DotyposCustomerIdSchema.make("active"),
            firstName: "Jana",
          },
          {
            ...customerDefaults,
            id: DotyposCustomerIdSchema.make("deleted"),
            firstName: "Petr",
            deleted: true,
          },
          {
            ...customerDefaults,
            id: DotyposCustomerIdSchema.make("expired"),
            firstName: "Eva",
            expireDate: "2020-01-01T00:00:00Z",
          },
        ] satisfies DotyposCustomer[]
      ).map((customer) => [customer.id, customer])
    );
    const unavailable = new DotyposUnavailable({
      operation: "getCustomer",
      reason: "server",
    });
    const promotion = {
      id: promotionCodeId,
      kind: "discount",
      code: "SYNTHETIC",
      enabled: true,
      validFrom: null,
      validUntil: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      customers: audience,
    };
    const discount = {
      id: discountId,
      labels: { "en-US": "Synthetic", "cs-CZ": "Syntetická sleva" },
      percentageBasisPoints: 1000,
      fixedAmountValue: null,
      fixedAmountExponent: null,
      fixedAmountCurrency: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const recording = await makeRecordingWorkspaceDatabase();
    // The relational query reads discount code columns followed by its JSON relations.
    const discountCode = {
      id: codeId,
      code: promotion.code,
      enabled: promotion.enabled,
      validFrom: null,
      validUntil: null,
      promotionCodeId,
      promotionKind: promotion.kind,
      discountId,
      maxUses: null,
      maxUsesPerCustomer: null,
      serviceDateFrom: null,
      serviceDateUntil: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    recording.setRows([
      [[...Object.values(discountCode), promotion, discount, []]],
    ]);

    const detail = await Effect.gen(function* () {
      const reads = yield* makeDiscountAdministrationReads;
      return yield* reads.loadCodeDetail({
        codeId,
      });
    }).pipe(
      Effect.provide(
        readsLayer(
          recording.layer,
          Layer.mock(DotyposService, {
            getCustomersByIds: () => Effect.fail(unavailable),
            getCustomer: (id) =>
              id === "failing"
                ? Effect.fail(unavailable)
                : Effect.succeed(Option.fromNullishOr(customers.get(id))),
          })
        )
      ),
      Effect.runPromise
    );

    expect(
      detail.customers.map(({ customerId, customer }) => [
        customerId,
        customer?.id ?? null,
      ])
    ).toEqual([
      ["failing", null],
      ["deleted", "deleted"],
      ["expired", "expired"],
      ["active", "active"],
      ["missing", null],
    ]);
    const shown = new Map(
      detail.customers.map(({ customerId, customer }) => [customerId, customer])
    );
    for (const lifecycle of ["deleted", "expired"] as const)
      expect(shown.get(DotyposCustomerIdSchema.make(lifecycle))).toMatchObject({
        displayName: inactiveCustomerDisplayNames[lifecycle],
        hasName: false,
        lifecycle,
        email: null,
        phone: null,
      });
    expect(shown.get(DotyposCustomerIdSchema.make("active"))).toMatchObject({
      displayName: "Jana",
      lifecycle: "active",
    });
  });
});
