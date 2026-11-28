import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { testCustomerSession } from "@/features/account/backend/account-operations.test-utils";
import {
  CurrentCustomerAccount,
  requireVerifiedIdentity,
} from "@/features/account/backend/current-customer-account";
import { customerAccountUnavailable } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import type { HeldEntryPack } from "@/features/passes/backend/held-entry-packs";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import { plainDateStringSchema } from "@/shared/utils/temporal";

type HeldUnlimitedPass = Effect.Success<
  ReturnType<
    typeof import("@/features/passes/backend/held-unlimited-passes").listHeldUnlimitedPasses
  >
>[number];

class PassReadFailure extends Error {}

let heldUnlimitedPasses: Effect.Effect<
  readonly HeldUnlimitedPass[],
  PassReadFailure
> = Effect.succeed([]);
const listHeldUnlimitedPasses = mock(() => heldUnlimitedPasses);
let heldEntryPacks: Effect.Effect<readonly HeldEntryPack[], PassReadFailure> =
  Effect.succeed([]);
const listHeldEntryPacks = mock(() => heldEntryPacks);
let unlimitedCoverage: Effect.Effect<readonly never[], PassReadFailure> =
  Effect.succeed([]);

const heldUnlimitedPassReads = await import(
  "@/features/passes/backend/held-unlimited-passes"
);
mock.module("@/features/passes/backend/held-unlimited-passes", () => ({
  ...heldUnlimitedPassReads,
  listHeldUnlimitedPasses,
}));
const heldEntryPackReads = await import(
  "@/features/passes/backend/held-entry-packs"
);
mock.module("@/features/passes/backend/held-entry-packs", () => ({
  ...heldEntryPackReads,
  listHeldEntryPacks,
}));
const unlimitedPassWindows = await import(
  "@/features/passes/backend/unlimited-pass-window"
);
mock.module("@/features/passes/backend/unlimited-pass-window", () => ({
  ...unlimitedPassWindows,
  listUnlimitedPassCoverageWindows: () => unlimitedCoverage,
}));
const entryPackGifts = await import(
  "@/features/passes/backend/entry-pack-gift"
);
mock.module("@/features/passes/backend/entry-pack-gift", () => ({
  ...entryPackGifts,
  recoverEntryPackGiftClaims: () => Effect.void,
}));

const { loadCoworkCustomerPasses, unreadCoworkCustomerPasses } = await import(
  "./cowork-customer-passes"
);

const unlimitedPass = (
  overrides: Partial<HeldUnlimitedPass>
): HeldUnlimitedPass => ({
  orderId: orderIdSchema.make(crypto.randomUUID()),
  tier: "open-space",
  buyerAccountId: testCustomerSession.accountId,
  validFrom: plainDateStringSchema.make("2099-07-20"),
  validUntil: plainDateStringSchema.make("2099-08-19"),
  accessEndsOn: null,
  status: "active",
  paidAt: Temporal.Instant.from("2099-07-01T10:00:00Z"),
  grantedAt: Temporal.Instant.from("2099-07-01T10:00:00Z"),
  paymentState: "paid",
  renewalOverlaps: false,
  deskId: null,
  ...overrides,
});

const heldEntryPack: HeldEntryPack = {
  id: orderIdSchema.make("b53b3c15-9799-45d2-95b5-20f3ef69f3d2"),
  tier: "open-space",
  entryCount: 5,
  entriesLeft: 3,
  status: "active",
  paidAt: Temporal.Instant.from("2099-07-09T12:00:00Z"),
  validFrom: plainDateStringSchema.make("2099-07-09"),
  validUntil: plainDateStringSchema.make("2099-09-09"),
  claimedDates: [],
  bookedDates: [],
  reservedEntryDates: {},
  giftIssuedAt: null,
  giftClaimedAt: null,
  giftPaymentIsUsable: true,
};

const load = (
  requireActive: Effect.Success<
    typeof CurrentCustomerAccount
  >["requireActive"] = requireVerifiedIdentity(testCustomerSession)
) =>
  loadCoworkCustomerPasses(undefined).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceDatabase, {}),
        Layer.mock(CurrentCustomerAccount, { requireActive })
      )
    ),
    // The page serves the same fallback when the read fails.
    runWorkspaceEffectOrElse("cowork.load-booking-passes.test", {
      failureCode: "cowork.booking-passes-unavailable",
      orElse: () => unreadCoworkCustomerPasses,
    })
  );

const originalNow = Temporal.Now.instant;
beforeEach(() => {
  mock.clearAllMocks();
  heldUnlimitedPasses = Effect.succeed([]);
  heldEntryPacks = Effect.succeed([]);
  unlimitedCoverage = Effect.succeed([]);
  Temporal.Now.instant = () => Temporal.Instant.from("2099-07-30T10:00:00Z");
});
afterEach(() => {
  Temporal.Now.instant = originalNow;
});

describe("loadCoworkCustomerPasses", () => {
  test.each([
    ["a signed-out", requireVerifiedIdentity(null)],
    [
      "an awaiting-deletion",
      requireVerifiedIdentity({
        ...testCustomerSession,
        deletionRequested: true,
      }),
    ],
  ])("offers passes to %s visitor without reading any", async (_, session) => {
    expect(await load(session)).toEqual({
      bookingPasses: { packs: [], claimedDates: [] },
      passPurchaseOffered: true,
    });
    expect(listHeldUnlimitedPasses).not.toHaveBeenCalled();
  });

  test("withholds every pass when the session can't be read", async () => {
    heldEntryPacks = Effect.succeed([heldEntryPack]);
    expect(
      await load(
        Effect.fail(customerAccountUnavailable("authentication.session"))
      )
    ).toEqual(unreadCoworkCustomerPasses);
    expect(listHeldEntryPacks).not.toHaveBeenCalled();
    expect(listHeldUnlimitedPasses).not.toHaveBeenCalled();
  });

  test("offers passes to a signed-in customer without an Unlimited pass", async () => {
    expect((await load()).passPurchaseOffered).toBe(true);
    expect(listHeldUnlimitedPasses).toHaveBeenCalledWith(
      testCustomerSession.accountId
    );
  });

  test.each([
    ["an active", unlimitedPass({})],
    [
      "an upcoming",
      unlimitedPass({
        validFrom: plainDateStringSchema.make("2099-08-05"),
        validUntil: plainDateStringSchema.make("2099-09-04"),
      }),
    ],
    [
      "a withdrawn but still accessible",
      unlimitedPass({
        status: "withdrawn",
        accessEndsOn: plainDateStringSchema.make("2099-08-01"),
      }),
    ],
  ])(
    "withholds passes from a customer holding %s Unlimited pass",
    async (_, pass) => {
      heldUnlimitedPasses = Effect.succeed([pass]);
      expect((await load()).passPurchaseOffered).toBe(false);
    }
  );

  test.each([
    [
      "an expired",
      unlimitedPass({
        validFrom: plainDateStringSchema.make("2099-06-01"),
        validUntil: plainDateStringSchema.make("2099-07-01"),
      }),
    ],
    ["an ended", unlimitedPass({ status: "cancelled" })],
  ])(
    "offers passes to a customer holding only %s Unlimited pass",
    async (_, pass) => {
      heldUnlimitedPasses = Effect.succeed([pass]);
      expect((await load()).passPurchaseOffered).toBe(true);
    }
  );

  test.each([
    ["fails", Effect.fail(new PassReadFailure())],
    ["dies", Effect.die(new PassReadFailure())],
  ])(
    "keeps a usable Entry pack bookable when the Unlimited pass read %s",
    async (_, unlimitedRead) => {
      heldEntryPacks = Effect.succeed([heldEntryPack]);
      heldUnlimitedPasses = unlimitedRead;
      const passes = await load();
      expect(passes.passPurchaseOffered).toBe(false);
      expect(passes.bookingPasses.packs).toEqual([
        expect.objectContaining({ id: heldEntryPack.id, entriesLeft: 3 }),
      ]);
    }
  );

  test.each([
    [
      "Entry packs",
      () => {
        heldEntryPacks = Effect.fail(new PassReadFailure());
      },
    ],
    [
      "Unlimited coverage",
      () => {
        heldEntryPacks = Effect.succeed([heldEntryPack]);
        unlimitedCoverage = Effect.fail(new PassReadFailure());
      },
    ],
  ])("withholds every pass when %s can't be read", async (_, failRead) => {
    failRead();
    expect(await load()).toEqual(unreadCoworkCustomerPasses);
  });
});
