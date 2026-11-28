import "@/shared/testing/workspace-test-env";
import { describe, expect, test } from "bun:test";
import { DotyposCustomerSchema, DotyposUnavailable } from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { GoogleCalendarService } from "@deskohub/google-calendar";
import { testEmailAddress } from "@deskohub/test-email";
import { EmailValueName } from "@deskohub/workspace-admin-api";
import { Effect, Layer, Option, Schema } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import {
  type AdministrationCustomerActivity,
  AdministrationService,
} from "@/features/administration/administration.service";
import { AccountRoleGrants } from "@/features/administrators/backend/account-role-grants.service";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import {
  adminCodeClaim,
  adminCustomer,
  adminCustomerCode,
  adminCustomerProfile,
  adminCustomerVoucher,
  adminVoucherClaim,
} from "@/features/discounts/admin/customer-admin-fixtures.test-utils";
import { DiscountAdministration } from "@/features/discounts/admin/discount-administration.service";
import {
  type VoucherId,
  voucherIdSchema,
} from "@/features/discounts/persistence-contracts";
import { WorkspaceReservationDetailsMalformedError } from "@/features/reservation/backend/stored-reservation-details.server";
import { dotyposCustomerIdSchema } from "@/features/reservation/dotypos-customer";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  CalendarResourceConfig,
  salesCalendarIdSchema,
  workspaceLimitationsCalendarIdSchema,
} from "@/shared/backend/config/calendar-resource.config";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";
import { CustomerValueSource } from "./customer-value-source.service";
import { CustomerValues } from "./customer-values.service";

const customerId = Schema.decodeUnknownSync(dotyposCustomerIdSchema)(
  "synthetic-customer"
);
const actor = {
  accountId: Schema.decodeUnknownSync(customerAccountIdSchema)(
    "synthetic-administrator"
  ),
  email: testEmailAddress("customer-values-administrator"),
};

const profile = adminCustomerProfile({
  customer: adminCustomer({
    id: customerId,
    displayName: "Synthetic customer",
    email: testEmailAddress("customer-values"),
    phone: null,
  }),
});
const activity: AdministrationCustomerActivity = {
  reservations: [],
  transactions: [],
  reservationHistoryTruncated: true,
  transactionHistoryTruncated: false,
  marketingConsent: null,
  stats: {
    reservationCount: 0,
    favoriteProduct: null,
    revenue: [],
    discountSavings: [],
    favoriteReservationProduct: { kind: "meeting-room" },
  },
};

const sourceLayer = (
  input: {
    readonly allowed?: () => boolean;
    readonly loadProfile?: DiscountAdministration["Service"]["loadCustomerProfile"];
    readonly loadActivity?: AdministrationService["Service"]["loadCustomerActivityStrict"];
  } = {}
) =>
  CustomerValueSource.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AccountRoleGrants, {
          has: () => Effect.sync(input.allowed ?? (() => true)),
        }),
        Layer.mock(DiscountAdministration, {
          loadCustomerProfile:
            input.loadProfile ?? (() => Effect.succeed(profile)),
        }),
        Layer.mock(AdministrationService, {
          loadCustomerActivityStrict:
            input.loadActivity ?? (() => Effect.succeed(activity)),
        })
      )
    )
  );

const runProfile = (
  layer: ReturnType<typeof sourceLayer>,
  authenticated = true
) =>
  Effect.flatMap(CustomerValueSource, (source) =>
    source.profile({ customerId })
  ).pipe(
    Effect.provide(layer),
    Effect.provide(
      authenticated ? Layer.succeed(CurrentAdministrator, actor) : Layer.empty
    ),
    Effect.result,
    Effect.runPromise
  );

describe("CustomerValueSource", () => {
  test("refuses absent or revoked administrators before customer lookup and rechecks every call", async () => {
    let calls = 0;
    let allowed = true;
    const layer = sourceLayer({
      allowed: () => allowed,
      loadProfile: () =>
        Effect.sync(() => {
          calls++;
          return profile;
        }),
    });
    const anonymous = await runProfile(layer, false);
    expect(anonymous).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueUnauthorized" },
    });
    expect(calls).toBe(0);
    expect(await runProfile(layer)).toMatchObject({ _tag: "Success" });
    allowed = false;
    expect(await runProfile(layer)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueUnauthorized" },
    });
    expect(calls).toBe(1);
  });

  test("delivery reads need no request actor and never consult administrator grants", async () => {
    let grantChecks = 0;
    const layer = CustomerValueSource.Delivery.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(DiscountAdministration, {
            loadCustomerProfile: () => Effect.succeed(profile),
          }),
          Layer.mock(AdministrationService, {
            loadCustomerActivityStrict: () => Effect.succeed(activity),
          })
        )
      )
    );
    expect(await runProfile(layer, false)).toMatchObject({
      _tag: "Success",
    });
    // The administrator layer still refuses the same anonymous read.
    const administrator = sourceLayer({
      allowed: () => {
        grantChecks++;
        return true;
      },
    });
    expect(await runProfile(administrator, false)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueUnauthorized" },
    });
    expect(grantChecks).toBe(0);
  });

  test("one runtime keeps administrator reads checked while its delivery reads need no actor", async () => {
    const dependencies = Layer.mergeAll(
      Layer.mock(AccountRoleGrants, { has: () => Effect.succeed(true) }),
      Layer.mock(DiscountAdministration, {
        loadCustomerProfile: () => Effect.succeed(profile),
      }),
      Layer.mock(AdministrationService, {
        loadCustomerActivityStrict: () => Effect.succeed(activity),
      })
    );
    const resolve = Effect.flatMap(CustomerValues, (values) =>
      values.resolve({
        customerId,
        definition: {
          name: Schema.decodeUnknownSync(EmailValueName)("contact"),
          source: { kind: "customer", path: ["profile", "customer", "email"] },
        },
        locale: "en-US",
      })
    ).pipe(Effect.result);
    const [before, delivery, after] = await Effect.all([
      resolve,
      resolve.pipe(Effect.provide(CustomerValues.Delivery)),
      resolve,
    ]).pipe(
      Effect.provide(
        CustomerValues.Default.pipe(Layer.provide(CustomerValueSource.Default))
      ),
      Effect.provide(dependencies),
      Effect.runPromise
    );
    expect(before).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueUnauthorized" },
    });
    expect(delivery).toMatchObject({
      _tag: "Success",
      success: profile.customer.email,
    });
    expect(after).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueUnauthorized" },
    });
  });

  test("reads the real administration profile path with synthetic Dotypos and storage", async () => {
    const calls: string[] = [];
    const database = await makeRecordingWorkspaceDatabase();
    const discounts = DiscountAdministration.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          // Every stored code and voucher query answers with no rows.
          database.layer,
          DotyposServiceMock({
            getCustomer: (id) =>
              Effect.sync(() => {
                calls.push(id);
                return Option.some(
                  Schema.decodeUnknownSync(DotyposCustomerSchema)({
                    id,
                    _cloudId: "synthetic-cloud",
                    firstName: "Synthetic",
                    email: testEmailAddress("real-customer-value-path"),
                    points: "0",
                    flags: "0",
                    display: true,
                    deleted: false,
                  })
                );
              }),
            getDiscountGroups: () => Effect.succeed([]),
          }),
          Layer.mock(GoogleCalendarService, {}),
          Layer.mock(CalendarResourceConfig, {
            salesCalendarId: salesCalendarIdSchema.make("synthetic-calendar"),
            workspaceLimitationsCalendarId:
              workspaceLimitationsCalendarIdSchema.make(
                "synthetic-limitations-calendar"
              ),
          })
        )
      )
    );
    const layer = CustomerValueSource.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          discounts,
          Layer.mock(AdministrationService, {}),
          Layer.mock(AccountRoleGrants, { has: () => Effect.succeed(true) })
        )
      )
    );
    const result = await runProfile(layer);
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        customer: {
          displayName: "Synthetic",
          email: testEmailAddress("real-customer-value-path"),
        },
      },
    });
    expect(calls).toEqual([customerId]);
    if (result._tag === "Success")
      expect(Object.keys(result.success.customer).sort()).toEqual([
        "discountGroupId",
        "displayName",
        "email",
        "id",
        "phone",
      ]);
  });

  test("keeps source failure distinct from a missing customer without retaining payload causes", async () => {
    const { DiscountAdminNotFoundError } = await import(
      "@/features/discounts/admin/discount-administration-errors"
    );
    const missing = await runProfile(
      sourceLayer({
        loadProfile: () =>
          Effect.fail(
            new DiscountAdminNotFoundError({
              resource: { kind: "Dotypos customer", id: customerId },
              message: "missing",
            })
          ),
      })
    );
    const unavailable = await runProfile(
      sourceLayer({
        loadProfile: () =>
          Effect.fail(
            new DotyposUnavailable({
              operation: "getCustomer",
              reason: "server",
              cause: { email: testEmailAddress("sensitive-error") },
            })
          ),
      })
    );
    expect(missing).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueMissing", reason: "customer-not-found" },
    });
    expect(unavailable).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueUnavailable", source: "profile" },
    });
    expect(JSON.stringify(unavailable)).not.toContain(
      testEmailAddress("sensitive-error")
    );
  });

  test("serializes nested code dates and strips internal code metadata", async () => {
    const at = Temporal.Instant.from("2026-10-01T10:00:00Z");
    const result = await runProfile(
      sourceLayer({
        loadProfile: () =>
          Effect.succeed({
            ...profile,
            codes: [
              adminCustomerCode({
                code: "SYNTHETIC_NONREDEEMABLE",
                enabled: false,
                validFrom: at,
                validUntil: null,
                audienceSize: 1,
                reservedUses: 0,
                redeemedUses: 0,
                releasedUses: 0,
                createdAt: at,
                updatedAt: at,
                maxUses: 1,
                maxUsesPerCustomer: 1,
                remainingUses: 1,
                discountLabel: "Synthetic",
                eligible: true,
                discountLabels: {
                  "cs-CZ": "Internal-only synthetic label",
                  "en-US": "Internal-only synthetic label",
                },
              }),
            ],
          }),
      })
    );
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        codes: [
          {
            validFrom: at.toString(),
            validUntil: null,
            createdAt: at.toString(),
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(
      "Internal-only synthetic label"
    );
  });

  test("serializes claim and voucher dates whether or not they are set", async () => {
    const at = Temporal.Instant.from("2026-10-01T10:00:00Z");
    const later = Temporal.Instant.from("2026-10-02T10:00:00Z");
    const settlement = (settledAt: "redeemed" | "released") =>
      ({
        dotyposCustomerId: customerId,
        state: settledAt,
        reservationExpiresAt: later,
        reservedAt: at,
        redeemedAt: settledAt === "redeemed" ? later : null,
        releasedAt: settledAt === "released" ? later : null,
        releaseReason: null,
      }) as const;
    const firstVoucherId = Schema.decodeUnknownSync(voucherIdSchema)(
      "019b0000-0000-7000-8000-000000000011"
    );
    const secondVoucherId = Schema.decodeUnknownSync(voucherIdSchema)(
      "019b0000-0000-7000-8000-000000000012"
    );
    const voucher = (id: VoucherId, validFrom: Temporal.Instant | null) =>
      adminCustomerVoucher({
        id,
        code: `SYNTHETIC_VOUCHER_${id.slice(-1)}`,
        enabled: true,
        validFrom,
        validUntil: validFrom ? null : later,
        audienceSize: 1,
        reservedUses: 0,
        redeemedUses: 0,
        releasedUses: 0,
        createdAt: at,
        updatedAt: at,
        issuedCredit: { value: 10_000, exponent: 2, currency: "CZK" },
        remainingCredit: { value: 10_000, exponent: 2, currency: "CZK" },
        eligible: true,
      });
    const result = await runProfile(
      sourceLayer({
        loadProfile: () =>
          Effect.succeed({
            ...profile,
            claims: [
              adminCodeClaim(settlement("redeemed")),
              adminCodeClaim(settlement("released")),
            ],
            vouchers: [
              voucher(firstVoucherId, at),
              voucher(secondVoucherId, null),
            ],
            voucherClaims: [
              adminVoucherClaim({
                ...settlement("redeemed"),
                voucherId: firstVoucherId,
              }),
              adminVoucherClaim({
                ...settlement("released"),
                voucherId: secondVoucherId,
              }),
            ],
          }),
      })
    );
    const settled = {
      reservationExpiresAt: later.toString(),
      reservedAt: at.toString(),
    };
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        claims: [
          { ...settled, redeemedAt: later.toString(), releasedAt: null },
          { ...settled, redeemedAt: null, releasedAt: later.toString() },
        ],
        vouchers: [
          { validFrom: at.toString(), validUntil: null },
          { validFrom: null, validUntil: later.toString() },
        ],
        voucherClaims: [
          { ...settled, redeemedAt: later.toString(), releasedAt: null },
          { ...settled, redeemedAt: null, releasedAt: later.toString() },
        ],
      },
    });
  });

  test("rejects malformed source data instead of returning it as missing", async () => {
    const malformed = await runProfile(
      sourceLayer({
        loadProfile: () =>
          Effect.sync(() => {
            const customer = { ...profile.customer };
            // A malformed source can hand back what the profile type forbids.
            Reflect.set(customer, "email", 123);
            return { ...profile, customer };
          }),
      })
    );
    expect(malformed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueRejected", reason: "invalid-data" },
    });
  });

  test("rejects malformed stored activity instead of reporting a temporary failure", async () => {
    const result = await Effect.flatMap(CustomerValueSource, (source) =>
      source.activity({ customerId })
    ).pipe(
      Effect.provide(
        sourceLayer({
          loadActivity: () =>
            Effect.fail(
              new WorkspaceReservationDetailsMalformedError({
                reservationId: Schema.decodeUnknownSync(
                  workspaceReservationIdSchema
                )("019b0000-0000-7000-8000-000000000003"),
                message: "Synthetic malformed reservation details",
                cause: { email: testEmailAddress("malformed-customer-value") },
              })
            ),
        })
      ),
      Effect.provideService(CurrentAdministrator, actor),
      Effect.result,
      Effect.runPromise
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CustomerValueRejected", reason: "invalid-data" },
    });
    expect(JSON.stringify(result)).not.toContain(
      testEmailAddress("malformed-customer-value")
    );
  });

  test("projects activity to the authoritative contract and keeps nulls and bounded history flags", async () => {
    const result = await Effect.flatMap(CustomerValueSource, (source) =>
      source.activity({ customerId })
    ).pipe(
      Effect.provide(sourceLayer()),
      Effect.provideService(CurrentAdministrator, actor),
      Effect.runPromise
    );
    expect(result.reservationHistoryTruncated).toBe(true);
    expect(result.marketingConsent).toBeNull();
    expect(result.stats.favoriteProduct).toBeNull();
    expect(Object.hasOwn(result.stats, "favoriteReservationProduct")).toBe(
      false
    );
  });
});
