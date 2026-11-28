import type { DotyposCustomerId } from "@deskohub/dotypos";
import { testEmailAddress } from "@deskohub/test-email";
import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { PostHogFeatureFlagEvaluationError } from "@deskohub/analytics-posthog/feature-flags/node";
import { CloudinaryConfigError } from "@deskohub/cloudinary";
import { DotyposUnavailable } from "@deskohub/dotypos";
import { ReferralCode } from "@deskohub/workspace-customer-api/referral-code";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Cause, Effect, Layer, Predicate, Schema, SchemaIssue } from "effect";
import { SqlError } from "effect/sql";
import { redirect } from "next/navigation";
import {
  AccountAvatarReleaseGate,
  PasskeyReleaseGate,
} from "@/features/account/backend/account-release-gates";
import { CustomerAgentConnections } from "@/features/account/backend/auth/customer-agent-connections.service";
import { CustomerPasskeys } from "@/features/account/backend/auth/customer-passkeys.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import {
  type CustomerAccountSession,
  CustomerAuthentication,
} from "@/features/account/backend/customer-authentication.service";
import { testSessionProfile } from "@/features/account/backend/customer-authentication.test-utils";
import {
  CustomerAvatarProviderError,
  CustomerAvatarService,
} from "@/features/account/backend/customer-avatar.service";
import { CustomerProfileService } from "@/features/account/backend/customer-profile.service";
import {
  CustomerReservationHistoryService,
  type ReservationHistoryAccount,
} from "@/features/account/backend/customer-reservation-history.service";
import {
  CustomerAccountAccessError,
  type CustomerAccountId,
  customerAccountIdSchema,
  customerAccountUnavailable,
} from "@/features/account/customer-account";
import type { CustomerAgentConnection } from "@/features/account/customer-agent-connections";
import { promotionCodeIdSchema } from "@/features/discounts/persistence-contracts";
import { WorkspaceFeatureFlagServiceMock } from "@/features/feature-flags/backend/workspace-feature-flag.service.mock";
import { getReferralShareUrl } from "@/features/referrals/client";
import { ReferralError } from "@/features/referrals/contracts";
import { ReferralService } from "@/features/referrals/referral.service";
import { ReferralServiceMock } from "@/features/referrals/referral.service.mock";
import { ReferralReleaseGate } from "@/features/referrals/referral-release-gate";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import { ReferralSignupIntentRepository } from "@/features/referrals/signup-intent.repository";
import { dotyposCustomerIdSchema } from "@/features/reservation/dotypos-customer";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { ReviewAccountsMock } from "@/features/review-accounts/backend/review-accounts.repository.mock";
import { getWorkspaceRuntimeCallbackOrigin } from "@/shared/backend/config/workspace-url.config";
import { findNextControlFlow } from "@/shared/backend/workspace-effect";
import {
  type AccountPageLayers,
  accountPageCapabilities,
} from "./account-page-capabilities.server";
import type { CustomerReservationSummary } from "./contracts";
import { loadAccountPageState } from "./page-data.server";

const customerEmail = testEmailAddress("ada");

const accountId = Schema.decodeSync(customerAccountIdSchema)("auth-account-1");
const activeSession = {
  accountId,
  email: Schema.decodeSync(reservationCustomerEmailSchema)(customerEmail),
  deletionRequested: false,
  ...testSessionProfile,
} satisfies CustomerAccountSession;

type ResolvedStanding = Effect.Success<
  CurrentCustomerAccount["Service"]["resolve"]
>;

/** The standing the account's resolution reports, as tests name it. */
type StandingSpec =
  | {
      readonly kind: "linked";
      readonly customerId: string;
      readonly autoLinked?: boolean;
    }
  | {
      readonly kind: "support-required";
      readonly reason: "ambiguous" | "unusable" | "claimed";
    }
  | {
      readonly kind:
        | "signed-out"
        | "unverified"
        | "deletion-pending"
        | "review"
        | "profile-missing";
    }
  | {
      readonly kind: "unavailable";
      /** What failed; the lock by default. */
      readonly failure?: CustomerAccountAccessError;
    };

/** The review marker every signed-in standing reports. */
let reviewMarker: "absent" | "unreadable";

/**
 * The fake resolution's standing for the active session, built when the page
 * reads it, so a test may set `reviewMarker` afterwards.
 */
const standing = (
  spec: StandingSpec
): Effect.Effect<ResolvedStanding, CustomerAccountAccessError> =>
  Effect.sync((): ResolvedStanding => {
    const facts = { session: activeSession, reviewMarker };
    switch (spec.kind) {
      case "signed-out":
      case "unverified":
        return { kind: spec.kind };
      case "review":
        return { kind: "review", session: activeSession };
      case "deletion-pending":
      case "profile-missing":
        return { kind: spec.kind, ...facts };
      case "support-required":
        return { ...spec, ...facts };
      case "unavailable":
        return {
          kind: "unavailable",
          failure:
            spec.failure ?? customerAccountUnavailable("account-link.lock"),
          ...facts,
        };
      case "linked":
        return {
          kind: "linked",
          account: {
            accountId,
            dotyposCustomerId: Schema.decodeSync(dotyposCustomerIdSchema)(
              spec.customerId
            ),
          },
          autoLinked: spec.autoLinked ?? false,
          ...facts,
        };
    }
  });

let currentStanding: Effect.Effect<
  ResolvedStanding,
  CustomerAccountAccessError
>;
let resolverCalls = 0;
let events: string[] = [];
let profileLoadCalls = 0;
let historyLoadCalls = 0;
let historyLoadAccounts: ReservationHistoryAccount[] = [];
let avatarLookupCalls = 0;

const linkedProfile = Effect.succeed({
  firstName: "Ada",
  lastName: "Lovelace",
  phone: null,
  billing: null,
});
let profileLoadEffect: ReturnType<CustomerProfileService["Service"]["load"]>;

let historyEffect: ReturnType<
  CustomerReservationHistoryService["Service"]["load"]
>;

let avatarLookupEffect: ReturnType<CustomerAvatarService["Service"]["lookup"]>;

const referralSummary = {
  code: Schema.decodeSync(ReferralCode)("RFL12345"),
  inviteeCount: 0,
  eligibleInviteeCount: 0,
  discount: "0",
  savings: [],
} as const;
let referralSummaryEffect: ReturnType<
  ReferralService["Service"]["getAccountSummary"]
>;
let referralSummaryCalls: Array<{
  readonly customerAccountId: CustomerAccountId;
  readonly dotyposCustomerId: DotyposCustomerId;
}> = [];
let availableReferralCodeEffect: ReturnType<
  ReferralService["Service"]["findAvailableCode"]
>;
let availableReferralCodeCalls: Array<{ readonly code: unknown }> = [];
let acceptReferralEffect: ReturnType<
  ReferralService["Service"]["acceptReferral"]
>;
let settledReferralEffect: ReturnType<
  ReferralService["Service"]["hasSettledReferral"]
>;
let settledReferralCalls: Array<{ readonly dotyposCustomerId: string }> = [];
let acceptReferralCalls: Array<{
  readonly code: unknown;
  readonly customerAccountId: CustomerAccountId;
  readonly dotyposCustomerId: string;
}> = [];
const accountReferrals = {
  summary: referralSummary,
  shareUrl: getReferralShareUrl(
    referralSummary.code,
    Effect.runSync(getWorkspaceRuntimeCallbackOrigin)
  ),
  discountPerInvitee: "5",
  invitationDiscount: "15",
  savingsCurrency: "CZK",
};

type StoredSignupIntent = Effect.Success<
  ReturnType<ReferralSignupIntentRepository["Service"]["find"]>
>;
const unsettledIntent = {
  code: "RFLPENDING",
  promotionCodeId: Schema.decodeSync(promotionCodeIdSchema)(
    "@test/promotion-code-id"
  ),
  referrerDotyposCustomerId: Schema.decodeSync(dotyposCustomerIdSchema)(
    "70001"
  ),
  outcome: null,
  acknowledged: false,
} satisfies StoredSignupIntent;
let storedSignupIntent: StoredSignupIntent;

const authoredReservation = {
  id: "workspace-reservation-1",
  party: { kind: "booked-for", customerName: "Karla Ukázková" },
  product: { kind: "meeting-room" },
  startsAt: "2026-10-15T09:00:00Z",
  endsAt: "2026-10-15T10:00:00Z",
  seats: 2,
  status: "confirmed",
} satisfies CustomerReservationSummary;

const sqlFailure = (message: string) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({
      cause: new Error(message),
      message,
      operation: "connect",
    }),
  });
const databaseOutage = sqlFailure("synthetic database outage");
const dotyposFailure = new DotyposUnavailable({
  operation: "getReservationsByIds",
  reason: "transport",
  message: "dotypos down",
});
const profileFailure = customerAccountUnavailable("dotypos.customer-lookup");
const acknowledgeSignupIntent = () => {
  assert(storedSignupIntent, "Expected a stored signup intent");
  storedSignupIntent = { ...storedSignupIntent, acknowledged: true };
};

let rememberedReferralCode: string | undefined;
let rememberedReferralCodeReads = 0;
const cookieWithCountingGetter = {
  get value() {
    rememberedReferralCodeReads += 1;
    return rememberedReferralCode;
  },
};

const avatarsFlag = mock(() => Promise.resolve(true));
const passkeysFlag = mock(() => Promise.resolve(false));
const referralsFlag = mock(() => Promise.resolve(true));

const accountPasskey = {
  id: "passkey-1",
  name: "Google Password Manager",
  provider: "Google Password Manager",
  createdAt: "2026-10-14T16:40:00.000Z",
} as const;
let passkeyListEffect: CustomerPasskeys["Service"]["list"];
let passkeyListCalls = 0;
let assistantListEffect: CustomerAgentConnections["Service"]["list"];
let assistantListCalls = 0;

/** Layers a test replaces, such as one whose build fails. */
let layerOverrides: Partial<AccountPageLayers> = {};

const flagEvaluation = WorkspaceFeatureFlagServiceMock({
  isEnabled: (key) =>
    Effect.tryPromise({
      try: () => {
        if (key === "account_avatars") return avatarsFlag();
        if (key === "login_passkeys") return passkeysFlag();
        throw new Error(`unexpected flag ${key}`);
      },
      catch: (cause) =>
        new PostHogFeatureFlagEvaluationError({
          cause,
          message: "Synthetic flag evaluation failed",
        }),
    }),
});

/**
 * The page's layers over the test's fakes, built through the page's own
 * composition.
 */
const pageLayer = () =>
  accountPageCapabilities({
    authentication: Layer.mock(CustomerAuthentication, {
      currentUser: Effect.succeed(activeSession),
    }),
    currentAccount: Layer.mock(CurrentCustomerAccount, {
      resolve: Effect.suspend(() => {
        resolverCalls += 1;
        return currentStanding.pipe(
          Effect.ensuring(Effect.sync(() => events.push("resolved")))
        );
      }),
    }),
    profile: Layer.mock(CustomerProfileService, {
      load: () => {
        profileLoadCalls += 1;
        return profileLoadEffect;
      },
    }),
    history: Layer.mock(CustomerReservationHistoryService, {
      load: (account) => {
        historyLoadCalls += 1;
        historyLoadAccounts.push(account);
        return historyEffect;
      },
    }),
    avatar: Layer.mock(CustomerAvatarService, {
      lookup: () => {
        avatarLookupCalls += 1;
        return avatarLookupEffect;
      },
    }),
    referrals: ReferralServiceMock({
      getAccountSummary: (input) => {
        referralSummaryCalls.push(input);
        events.push("summary");
        return referralSummaryEffect;
      },
      acceptReferral: (input) => {
        acceptReferralCalls.push(input);
        events.push("accept");
        return acceptReferralEffect;
      },
      findAvailableCode: (input) => {
        availableReferralCodeCalls.push(input);
        return availableReferralCodeEffect;
      },
      hasSettledReferral: (input) => {
        settledReferralCalls.push(input);
        events.push("settled");
        return settledReferralEffect;
      },
    }),
    assistants: Layer.mock(CustomerAgentConnections, {
      list: Effect.suspend(() => {
        assistantListCalls += 1;
        return assistantListEffect;
      }),
    }),
    passkeyRelease: PasskeyReleaseGate.Default.pipe(
      Layer.provide(flagEvaluation)
    ),
    avatarRelease: AccountAvatarReleaseGate.Default.pipe(
      Layer.provide(flagEvaluation)
    ),
    passkeys: Layer.mock(CustomerPasskeys, {
      list: Effect.suspend(() => {
        passkeyListCalls += 1;
        return passkeyListEffect;
      }),
    }),
    reviewAccounts: ReviewAccountsMock({
      isReviewAccount: () =>
        reviewMarker === "unreadable"
          ? Effect.fail(
              new EffectDrizzleQueryError({
                query: "select 1",
                params: [],
                cause: Cause.fail(databaseOutage),
              })
            )
          : Effect.succeed(false),
    }),
    signupIntents: Layer.mock(ReferralSignupIntentRepository, {
      find: () => Effect.sync(() => storedSignupIntent),
      settle: (_accountId, _promotionCodeId, outcome) =>
        Effect.sync(() => {
          if (!storedSignupIntent || storedSignupIntent.outcome !== null) {
            return false;
          }
          storedSignupIntent = { ...storedSignupIntent, outcome };
          return true;
        }),
    }),
    rememberedReferral: RememberedReferral.inMemory(
      cookieWithCountingGetter
    ).pipe(Layer.provide(Layer.mock(CurrentCustomerAccount, {}))),
    referralRelease: Layer.unwrap(
      Effect.promise(() => referralsFlag()).pipe(
        Effect.map(ReferralReleaseGate.fromDecision)
      )
    ),
    ...layerOverrides,
  });

describe("loadAccountPageState", () => {
  beforeEach(() => {
    reviewMarker = "absent";
    currentStanding = standing({ kind: "linked", customerId: "60111" });
    resolverCalls = 0;
    profileLoadCalls = 0;
    profileLoadEffect = linkedProfile;
    historyLoadCalls = 0;
    historyLoadAccounts = [];
    avatarLookupCalls = 0;
    layerOverrides = {};
    avatarLookupEffect = Effect.succeed(null);
    referralSummaryEffect = Effect.succeed(referralSummary);
    referralSummaryCalls = [];
    availableReferralCodeEffect = Effect.succeed(referralSummary.code);
    availableReferralCodeCalls = [];
    acceptReferralEffect = Effect.succeed({ kind: "accepted" });
    acceptReferralCalls = [];
    settledReferralEffect = Effect.succeed(false);
    settledReferralCalls = [];
    rememberedReferralCode = undefined;
    rememberedReferralCodeReads = 0;
    storedSignupIntent = undefined;
    events = [];
    avatarsFlag.mockReset();
    avatarsFlag.mockResolvedValue(true);
    passkeysFlag.mockReset();
    passkeysFlag.mockResolvedValue(false);
    passkeyListEffect = Effect.succeed([accountPasskey]);
    passkeyListCalls = 0;
    assistantListEffect = Effect.succeed([]);
    assistantListCalls = 0;
    referralsFlag.mockReset();
    referralsFlag.mockResolvedValue(true);
    historyEffect = Effect.succeed({
      kind: "available",
      groups: { current: [], past: [], unavailable: [] },
    });
  });

  const loadPageState = (remembered?: string) => {
    rememberedReferralCode = remembered;
    return Effect.runPromise(
      loadAccountPageState.pipe(Effect.provide(pageLayer()))
    );
  };

  test("returns unauthenticated without customer data or downstream work when signed out", async () => {
    currentStanding = standing({ kind: "signed-out" });

    await expect(loadPageState()).resolves.toEqual({
      kind: "unauthenticated",
    });
    expect(resolverCalls).toBe(1);
    expect(profileLoadCalls).toBe(0);
    expect(historyLoadCalls).toBe(0);
    expect(passkeyListCalls).toBe(0);
    expect(assistantListCalls).toBe(0);
  });

  test("is unavailable, with no section read, when the session can't be read or its email is unverified", async () => {
    passkeysFlag.mockResolvedValue(true);
    for (const outcome of [
      Effect.fail(customerAccountUnavailable("authentication.session")),
      Effect.fail(new CustomerAccountAccessError({ reason: "not-configured" })),
      standing({ kind: "unverified" }),
    ]) {
      currentStanding = outcome;

      await expect(loadPageState()).resolves.toEqual({ kind: "unavailable" });
    }
    expect(profileLoadCalls).toBe(0);
    expect(historyLoadCalls).toBe(0);
    expect(passkeyListCalls).toBe(0);
    expect(assistantListCalls).toBe(0);
  });

  test("prefills a currently usable remembered referral code on the completion state", async () => {
    currentStanding = standing({ kind: "profile-missing" });

    await expect(loadPageState("RFL12345")).resolves.toEqual({
      kind: "completion-required",
      deletion: "offered",
      assistants: [],
      referralsEnabled: true,
      email: customerEmail,
      referralCode: referralSummary.code,
    });
    expect(availableReferralCodeCalls).toEqual([{ code: "RFL12345" }]);
  });

  test("shows the reservations an account authored before completing its profile", async () => {
    currentStanding = standing({ kind: "profile-missing" });
    historyEffect = Effect.succeed({
      kind: "available",
      groups: { current: [authoredReservation], past: [], unavailable: [] },
    });

    await expect(loadPageState()).resolves.toEqual({
      kind: "completion-required",
      deletion: "offered",
      assistants: [],
      referralsEnabled: true,
      email: customerEmail,
      history: {
        kind: "available",
        groups: { current: [authoredReservation], past: [], unavailable: [] },
      },
    });
    expect(historyLoadAccounts).toEqual([{ accountId }]);
  });

  test("keeps an unreadable authored history as a notice on the completion state", async () => {
    currentStanding = standing({ kind: "profile-missing" });
    historyEffect = Effect.fail(dotyposFailure);

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "completion-required",
      history: { kind: "unavailable", reason: "provider-unavailable" },
    });
  });

  test("silently leaves the completion referral empty when the remembered code is not usable", async () => {
    currentStanding = standing({ kind: "profile-missing" });

    availableReferralCodeEffect = Effect.succeed(undefined);
    await expect(loadPageState("RFLGONE1")).resolves.toEqual({
      kind: "completion-required",
      deletion: "offered",
      assistants: [],
      referralsEnabled: true,
      email: customerEmail,
    });

    availableReferralCodeEffect = Effect.fail(databaseOutage);
    await expect(loadPageState("RFL12345")).resolves.toEqual({
      kind: "completion-required",
      deletion: "offered",
      assistants: [],
      referralsEnabled: true,
      email: customerEmail,
    });
  });

  test("records nothing from a remembered code once the account is linked", async () => {
    const state = await loadPageState("RFL12345");

    expect(state.kind).toBe("linked");
    expect(state).not.toHaveProperty("referralCode");
    expect(availableReferralCodeCalls).toEqual([]);
    expect(acceptReferralCalls).toEqual([]);
  });

  test("records the remembered invitation after this sign-in linked an existing customer", async () => {
    currentStanding = standing({
      kind: "linked",
      customerId: "60111",
      autoLinked: true,
    });

    const state = await loadPageState("RFL12345");

    expect(state).toMatchObject({
      kind: "linked",
      referrals: accountReferrals,
    });
    expect(acceptReferralCalls).toEqual([
      {
        code: "RFL12345",
        customerAccountId: accountId,
        dotyposCustomerId: "60111",
      },
    ]);
    expect(events).toEqual(["resolved", "accept", "settled", "summary"]);
  });

  test("retries the code a profile completion could not record yet, after resolution", async () => {
    storedSignupIntent = unsettledIntent;

    const state = await loadPageState();

    expect(state.kind).toBe("linked");
    expect(acceptReferralCalls).toEqual([
      {
        code: "RFLPENDING",
        customerAccountId: accountId,
        dotyposCustomerId: "60111",
      },
    ]);
    expect(events).toEqual(["resolved", "accept", "summary"]);
    expect(storedSignupIntent?.outcome).toBe("applied");
  });

  test("keeps showing a code settled as applied on later visits, without retrying, until acknowledged", async () => {
    storedSignupIntent = unsettledIntent;
    acceptReferralEffect = Effect.fail(
      new ReferralError({ reason: "pending_payment" })
    );

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      signupReferral: { status: "pending" },
    });
    expect(storedSignupIntent?.outcome ?? null).toBeNull();

    acceptReferralEffect = Effect.succeed({ kind: "accepted" });
    // The visit that settles the code may never reach the browser.
    await loadPageState();
    expect(storedSignupIntent?.outcome).toBe("applied");

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      signupReferral: { status: "applied" },
    });
    expect(acceptReferralCalls).toHaveLength(2);

    acknowledgeSignupIntent();
    const acknowledged = await loadPageState();
    expect(acknowledged.kind).toBe("linked");
    expect(acknowledged).not.toHaveProperty("signupReferral");
  });

  test("keeps showing a code settled as rejected after the first booking is paid, until acknowledged", async () => {
    storedSignupIntent = unsettledIntent;
    acceptReferralEffect = Effect.fail(
      new ReferralError({ reason: "ineligible" })
    );

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      signupReferral: { status: "not-applied", reason: "not-eligible" },
    });
    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      signupReferral: { status: "not-applied", reason: "not-eligible" },
    });
    expect(acceptReferralCalls).toHaveLength(1);

    acknowledgeSignupIntent();
    expect(await loadPageState()).not.toHaveProperty("signupReferral");
  });

  test("leaves a stored code unsettled when the linked page cannot render", async () => {
    storedSignupIntent = unsettledIntent;
    profileLoadEffect = Effect.fail(profileFailure);
    await expect(loadPageState()).resolves.toMatchObject({
      kind: "authenticated-unavailable",
    });
    expect(acceptReferralCalls).toEqual([]);
    expect(storedSignupIntent).toBeDefined();
  });

  test("records nothing when an auto-linked sign-in has no remembered code", async () => {
    currentStanding = standing({
      kind: "linked",
      customerId: "60111",
      autoLinked: true,
    });

    await expect(loadPageState()).resolves.toMatchObject({ kind: "linked" });
    expect(acceptReferralCalls).toEqual([]);
  });

  test("keeps the linked page and logs only a fixed reason when the invitation is not recorded", async () => {
    currentStanding = standing({
      kind: "linked",
      customerId: "60111",
      autoLinked: true,
    });
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(
        args
          .map((arg) => (Predicate.isString(arg) ? arg : JSON.stringify(arg)))
          .join(" ")
      );
    };
    const spies = [
      spyOn(console, "log").mockImplementation(capture),
      spyOn(console, "warn").mockImplementation(capture),
      spyOn(console, "error").mockImplementation(capture),
    ];

    try {
      for (const reason of [
        "unavailable",
        "self_referral",
        "ineligible",
        "already_attributed",
      ] as const) {
        acceptReferralEffect = Effect.fail(new ReferralError({ reason }));
        await expect(loadPageState("RFLSHARE")).resolves.toMatchObject({
          kind: "linked",
          profile: { firstName: "Ada" },
          referrals: accountReferrals,
        });
      }
      acceptReferralEffect = Effect.die(new Error("referral store down"));
      await expect(loadPageState("RFLSHARE")).resolves.toMatchObject({
        kind: "linked",
        referrals: accountReferrals,
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const output = lines.filter((line) => line.includes("WARN")).join("\n");
    expect(output).toContain("account.auto-link.referral");
    expect(output).toContain("self_referral");
    expect(output).toContain("ineligible");
    expect(output).toContain("already_attributed");
    expect(output).not.toContain("RFLSHARE");
    expect(output).not.toContain("referral store down");
  });

  test("forgets the remembered code once the linked customer's referral is settled", async () => {
    currentStanding = standing({
      kind: "linked",
      customerId: "60111",
      autoLinked: true,
    });
    storedSignupIntent = unsettledIntent;
    settledReferralEffect = Effect.succeed(true);

    await expect(loadPageState("RFL12345")).resolves.toMatchObject({
      kind: "linked",
      rememberedReferralCodeUsed: true,
    });
    expect(settledReferralCalls).toEqual([{ dotyposCustomerId: "60111" }]);
    expect(events).toEqual([
      "resolved",
      "accept",
      "accept",
      "settled",
      "summary",
    ]);
  });

  test("keeps the remembered code while the linked customer's referral is open or unknown", async () => {
    const open = await loadPageState("RFL12345");
    expect(open.kind).toBe("linked");
    expect(open).not.toHaveProperty("rememberedReferralCodeUsed");

    settledReferralEffect = Effect.fail(dotyposFailure);
    const unknown = await loadPageState("RFL12345");
    expect(unknown).toMatchObject({
      kind: "linked",
      referrals: accountReferrals,
    });
    expect(unknown).not.toHaveProperty("rememberedReferralCodeUsed");
    expect(settledReferralCalls).toHaveLength(2);
  });

  test("never checks whether the referral is settled without a remembered code", async () => {
    settledReferralEffect = Effect.succeed(true);

    const state = await loadPageState();

    expect(state.kind).toBe("linked");
    expect(state).not.toHaveProperty("rememberedReferralCodeUsed");
    expect(settledReferralCalls).toEqual([]);
  });

  test("renders the support state without a Reservations section for ambiguous, unusable, and claimed outcomes that authored nothing", async () => {
    currentStanding = standing({
      kind: "support-required",
      reason: "ambiguous",
    });
    await expect(loadPageState()).resolves.toEqual({
      kind: "support-required",
      deletion: "offered",
      assistants: [],
      email: customerEmail,
    });

    currentStanding = standing({
      kind: "support-required",
      reason: "unusable",
    });
    await expect(loadPageState()).resolves.toEqual({
      kind: "support-required",
      deletion: "offered",
      assistants: [],
      email: customerEmail,
    });

    currentStanding = standing({ kind: "support-required", reason: "claimed" });
    await expect(loadPageState()).resolves.toEqual({
      kind: "support-required",
      deletion: "offered",
      assistants: [],
      email: customerEmail,
    });
  });

  test("shows the reservations an account authored while support resolves its profile", async () => {
    historyEffect = Effect.succeed({
      kind: "available",
      groups: { current: [authoredReservation], past: [], unavailable: [] },
    });

    for (const reason of ["ambiguous", "unusable", "claimed"] as const) {
      currentStanding = standing({ kind: "support-required", reason });
      await expect(loadPageState()).resolves.toEqual({
        kind: "support-required",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
        history: {
          kind: "available",
          groups: { current: [authoredReservation], past: [], unavailable: [] },
        },
      });
    }
    expect(historyLoadAccounts).toEqual([
      { accountId },
      { accountId },
      { accountId },
    ]);
  });

  test("keeps an unreadable authored history as a notice on the support state", async () => {
    currentStanding = standing({ kind: "support-required", reason: "claimed" });
    historyEffect = Effect.fail(dotyposFailure);

    await expect(loadPageState()).resolves.toEqual({
      kind: "support-required",
      deletion: "offered",
      assistants: [],
      email: customerEmail,
      history: { kind: "unavailable", reason: "provider-unavailable" },
    });
  });

  test("reads no reservations when the locked recheck finds the email unverified or a pending deletion", async () => {
    historyEffect = Effect.succeed({
      kind: "available",
      groups: {
        current: [authoredReservation],
        past: [],
        unavailable: [],
      },
    });

    for (const failure of [
      new CustomerAccountAccessError({ reason: "unverified-email" }),
      new CustomerAccountAccessError({
        reason: "link-required",
        linkReason: "deletion-requested",
      }),
    ]) {
      currentStanding = standing({ kind: "unavailable", failure });
      await expect(loadPageState()).resolves.toEqual({
        kind: "support-required",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
      });
    }
    expect(historyLoadCalls).toBe(0);
  });

  test("shows the authenticated unavailable state when the link, lock, or Dotypos step fails", async () => {
    for (const failure of [
      customerAccountUnavailable("account-link.lock"),
      customerAccountUnavailable("dotypos.customer-lookup"),
    ]) {
      currentStanding = standing({ kind: "unavailable", failure });
      await expect(loadPageState()).resolves.toEqual({
        kind: "authenticated-unavailable",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
      });
    }
    expect(historyLoadCalls).toBe(0);
  });

  test("offers no deletion without a profile when the review marker can't be read", async () => {
    reviewMarker = "unreadable";
    currentStanding = standing({ kind: "unavailable" });

    await expect(loadPageState()).resolves.toEqual({
      kind: "authenticated-unavailable",
      assistants: [],
      email: customerEmail,
      deletion: "withheld",
    });

    for (const [outcome, kind] of [
      [standing({ kind: "profile-missing" }), "completion-required"],
      [
        standing({ kind: "support-required", reason: "ambiguous" }),
        "support-required",
      ],
    ] as const) {
      currentStanding = outcome;
      await expect(loadPageState()).resolves.toMatchObject({
        kind,
        deletion: "withheld",
      });
    }
  });

  test("keeps deletion for a linked account or a pending deletion when the review marker can't be read", async () => {
    reviewMarker = "unreadable";

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      deletion: "offered",
    });

    currentStanding = standing({ kind: "deletion-pending" });
    await expect(loadPageState()).resolves.toEqual({
      kind: "deletion-pending",
      email: customerEmail,
      deletion: "pending",
    });
  });

  test("renders the retryable deletion state when the durable marker is set", async () => {
    currentStanding = standing({ kind: "deletion-pending" });

    await expect(loadPageState()).resolves.toEqual({
      kind: "deletion-pending",
      email: customerEmail,
      deletion: "pending",
    });
  });

  test("renders the linked account with profile and grouped history", async () => {
    await expect(loadPageState()).resolves.toEqual({
      kind: "linked",
      deletion: "offered",
      assistants: [],
      referralsEnabled: true,
      email: customerEmail,
      profile: {
        firstName: "Ada",
        lastName: "Lovelace",
        phone: null,
        billing: null,
      },
      avatar: { kind: "available", avatar: null },
      history: {
        kind: "available",
        groups: { current: [], past: [], unavailable: [] },
      },
      referrals: accountReferrals,
    });
    expect(referralSummaryCalls).toEqual([
      {
        customerAccountId: accountId,
        dotyposCustomerId: Schema.decodeSync(dotyposCustomerIdSchema)("60111"),
      },
    ]);
  });

  test("logs fixed, cause-free warnings when history and avatar degrade", async () => {
    historyEffect = Effect.fail(dotyposFailure);
    const avatarFailure = new CustomerAvatarProviderError({});
    avatarLookupEffect = Effect.fail(avatarFailure);
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(
        args
          .map((arg) => (Predicate.isString(arg) ? arg : JSON.stringify(arg)))
          .join(" ")
      );
    };
    const spies = [
      spyOn(console, "log").mockImplementation(capture),
      spyOn(console, "warn").mockImplementation(capture),
      spyOn(console, "error").mockImplementation(capture),
    ];

    try {
      await expect(loadPageState()).resolves.toMatchObject({
        kind: "linked",
        avatar: { kind: "available", avatar: null },
        history: { kind: "unavailable", reason: "provider-unavailable" },
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const output = lines.filter((line) => line.includes("WARN")).join("\n");
    expect(output).toContain("account.reservation-history.unavailable");
    expect(output).toContain("account.avatar.unavailable");
    expect(output).not.toContain("dotypos down");
    expect(output).not.toContain(avatarFailure._tag);
  });

  test("keeps profile and history available while hiding avatars and skipping lookup when disabled", async () => {
    avatarsFlag.mockResolvedValue(false);

    await expect(loadPageState()).resolves.toEqual({
      kind: "linked",
      deletion: "offered",
      assistants: [],
      referralsEnabled: true,
      email: customerEmail,
      profile: {
        firstName: "Ada",
        lastName: "Lovelace",
        phone: null,
        billing: null,
      },
      avatar: { kind: "hidden" },
      history: {
        kind: "available",
        groups: { current: [], past: [], unavailable: [] },
      },
      referrals: accountReferrals,
    });
    expect(avatarLookupCalls).toBe(0);
    expect(profileLoadCalls).toBe(1);
    expect(historyLoadCalls).toBe(1);
  });

  test("fails closed without avatar lookup when avatar capability evaluation is unavailable", async () => {
    avatarsFlag.mockRejectedValue(new Error("flag unavailable"));

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      avatar: { kind: "hidden" },
      profile: { firstName: "Ada" },
      history: { kind: "available" },
    });
    expect(avatarLookupCalls).toBe(0);
  });

  test("lists the account's passkeys only while passkeys are on", async () => {
    await expect(loadPageState()).resolves.not.toHaveProperty("passkeys");
    expect(passkeyListCalls).toBe(0);

    passkeysFlag.mockResolvedValue(true);
    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      passkeys: { accountId, passkeys: [accountPasskey] },
    });
    expect(passkeyListCalls).toBe(1);
  });

  test("keeps the linked page with an unavailable passkey list", async () => {
    passkeysFlag.mockResolvedValue(true);
    passkeyListEffect = Effect.fail(
      customerAccountUnavailable("authentication.passkeys")
    );

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      profile: { firstName: "Ada" },
      passkeys: { accountId, passkeys: null },
    });
  });

  test("fails closed without listing passkeys when the flag is unavailable", async () => {
    passkeysFlag.mockRejectedValue(new Error("flag unavailable"));

    await expect(loadPageState()).resolves.not.toHaveProperty("passkeys");
    expect(passkeyListCalls).toBe(0);
  });

  test("lists passkeys from the session in every signed-in state without a usable profile", async () => {
    passkeysFlag.mockResolvedValue(true);
    const passkeys = { accountId, passkeys: [accountPasskey] };
    profileLoadEffect = Effect.fail(profileFailure);
    await expect(loadPageState()).resolves.toEqual({
      kind: "authenticated-unavailable",
      deletion: "offered",
      assistants: [],
      email: customerEmail,
      passkeys,
    });

    currentStanding = standing({ kind: "profile-missing" });
    await expect(loadPageState()).resolves.toMatchObject({
      kind: "completion-required",
      passkeys,
    });

    currentStanding = standing({
      kind: "support-required",
      reason: "ambiguous",
    });
    await expect(loadPageState()).resolves.toEqual({
      kind: "support-required",
      deletion: "offered",
      assistants: [],
      email: customerEmail,
      passkeys,
    });

    currentStanding = standing({ kind: "deletion-pending" });
    await expect(loadPageState()).resolves.toEqual({
      kind: "deletion-pending",
      deletion: "pending",
      email: customerEmail,
      passkeys,
    });
    expect(passkeyListCalls).toBe(4);
  });

  test("lists connected assistants in every signed-in state except a pending deletion", async () => {
    const assistant: CustomerAgentConnection = {
      id: "consent-synthetic",
      name: "Synthetic Assistant",
      host: "assistant.invalid",
      scopes: ["reservations:read"],
      administration: false,
      connectedAt: "2026-10-01T08:00:00.000Z",
    };
    assistantListEffect = Effect.succeed([assistant]);

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      assistants: [assistant],
    });

    profileLoadEffect = Effect.fail(profileFailure);
    await expect(loadPageState()).resolves.toEqual({
      kind: "authenticated-unavailable",
      deletion: "offered",
      email: customerEmail,
      assistants: [assistant],
    });

    currentStanding = standing({ kind: "profile-missing" });
    await expect(loadPageState()).resolves.toMatchObject({
      kind: "completion-required",
      assistants: [assistant],
    });

    currentStanding = standing({
      kind: "support-required",
      reason: "ambiguous",
    });
    await expect(loadPageState()).resolves.toEqual({
      kind: "support-required",
      deletion: "offered",
      email: customerEmail,
      assistants: [assistant],
    });
    expect(assistantListCalls).toBe(4);

    // A pending deletion's grants no longer authorize, and deleting the
    // account removes them.
    currentStanding = standing({ kind: "deletion-pending" });
    await expect(loadPageState()).resolves.toEqual({
      kind: "deletion-pending",
      email: customerEmail,
      deletion: "pending",
    });
    expect(assistantListCalls).toBe(4);
  });

  test("keeps the page with an unavailable assistant list", async () => {
    assistantListEffect = Effect.fail(
      customerAccountUnavailable("authentication.agent-connections")
    );

    await expect(loadPageState()).resolves.toMatchObject({
      kind: "linked",
      profile: { firstName: "Ada" },
      assistants: null,
    });
  });

  test("lists no passkeys once resolution finds no session", async () => {
    passkeysFlag.mockResolvedValue(true);
    currentStanding = standing({ kind: "signed-out" });

    await expect(loadPageState()).resolves.toEqual({
      kind: "unauthenticated",
    });
    expect(passkeyListCalls).toBe(0);
    expect(assistantListCalls).toBe(0);
  });

  test("renders the authenticated unavailable state when the profile read fails after a successful link", async () => {
    profileLoadEffect = Effect.fail(profileFailure);

    await expect(loadPageState()).resolves.toEqual({
      kind: "authenticated-unavailable",
      deletion: "offered",
      assistants: [],
      email: customerEmail,
    });
  });

  describe("while the referral program is withheld", () => {
    const expectNoReferralWork = () => {
      expect(rememberedReferralCodeReads).toBe(0);
      expect(availableReferralCodeCalls).toEqual([]);
      expect(acceptReferralCalls).toEqual([]);
      expect(settledReferralCalls).toEqual([]);
      expect(referralSummaryCalls).toEqual([]);
    };

    test("offers no completion referral field or prefill", async () => {
      referralsFlag.mockResolvedValue(false);
      currentStanding = standing({ kind: "profile-missing" });

      await expect(loadPageState("RFL12345")).resolves.toEqual({
        kind: "completion-required",
        deletion: "offered",
        assistants: [],
        referralsEnabled: false,
        email: customerEmail,
      });
      expectNoReferralWork();
    });

    test("skips the auto-link acceptance, signup retry, settlement check, and summary", async () => {
      referralsFlag.mockResolvedValue(false);
      currentStanding = standing({
        kind: "linked",
        customerId: "60111",
        autoLinked: true,
      });
      storedSignupIntent = unsettledIntent;
      settledReferralEffect = Effect.succeed(true);

      const state = await loadPageState("RFL12345");

      expect(state).toEqual({
        kind: "linked",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
        profile: {
          firstName: "Ada",
          lastName: "Lovelace",
          phone: null,
          billing: null,
        },
        avatar: { kind: "available", avatar: null },
        history: {
          kind: "available",
          groups: { current: [], past: [], unavailable: [] },
        },
        referralsEnabled: false,
        referrals: undefined,
      });
      expect(state).not.toHaveProperty("signupReferral");
      expect(state).not.toHaveProperty("rememberedReferralCodeUsed");
      expect(storedSignupIntent).toBe(unsettledIntent);
      expect(events).toEqual(["resolved"]);
      expectNoReferralWork();
    });

    test("decides the referral program once for the whole load", async () => {
      currentStanding = standing({
        kind: "linked",
        customerId: "60111",
        autoLinked: true,
      });

      await expect(loadPageState("RFL12345")).resolves.toMatchObject({
        kind: "linked",
        referralsEnabled: true,
      });
      // The page gate and every referral service of this load share one
      // decision, so none of them can see the program differently.
      expect(referralsFlag).toHaveBeenCalledTimes(1);
    });
  });
  describe("when a section's capabilities can't be built", () => {
    const configFailure = "configuration broken";
    const invalidConfiguration = new Schema.SchemaError(
      new SchemaIssue.InvalidType(Schema.Never.ast, configFailure, {
        reportInput: true,
      })
    );
    const failConfiguration = Effect.fail(invalidConfiguration);
    const unbuildableAvatar = Layer.effect(
      CustomerAvatarService,
      Effect.fail(new CloudinaryConfigError({ message: configFailure }))
    );
    const unbuildableHistory = Layer.effect(
      CustomerReservationHistoryService,
      failConfiguration
    );
    const unbuildableReferrals = Layer.effect(
      ReferralService,
      failConfiguration
    );
    const unloadable = Effect.die(new Error("module failed to load"));

    const loadWithWarnings = async (remembered?: string) => {
      const lines: string[] = [];
      const capture = (...args: unknown[]) => {
        lines.push(
          args
            .map((arg) => (Predicate.isString(arg) ? arg : JSON.stringify(arg)))
            .join(" ")
        );
      };
      const spies = [
        spyOn(console, "log").mockImplementation(capture),
        spyOn(console, "warn").mockImplementation(capture),
        spyOn(console, "error").mockImplementation(capture),
      ];
      try {
        return { state: await loadPageState(remembered), output: lines };
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    };

    const warnings = (output: readonly string[]) =>
      output.filter((line) => line.includes("WARN")).join("\n");

    test("degrades only the avatar when its media capability can't be built", async () => {
      layerOverrides = { avatar: unbuildableAvatar };

      const { state, output } = await loadWithWarnings();

      expect(state).toEqual({
        kind: "linked",
        deletion: "offered",
        assistants: [],
        referralsEnabled: true,
        email: customerEmail,
        profile: {
          firstName: "Ada",
          lastName: "Lovelace",
          phone: null,
          billing: null,
        },
        avatar: { kind: "available", avatar: null },
        history: {
          kind: "available",
          groups: { current: [], past: [], unavailable: [] },
        },
        referrals: accountReferrals,
      });
      expect(warnings(output)).toContain("account.avatar.unavailable");
      expect(output.join("\n")).not.toContain("configuration broken");
    });

    test("ignores a capability that can't be built while the page skips its section", async () => {
      layerOverrides = { avatar: unbuildableAvatar };
      avatarsFlag.mockResolvedValue(false);

      const { state, output } = await loadWithWarnings();

      expect(state).toMatchObject({
        kind: "linked",
        avatar: { kind: "hidden" },
      });
      expect(warnings(output)).not.toContain("account.avatar.unavailable");
    });

    test("degrades only the history when its capability can't be built", async () => {
      layerOverrides = { history: unbuildableHistory };

      const { state, output } = await loadWithWarnings();

      expect(state).toMatchObject({
        kind: "linked",
        avatar: { kind: "available", avatar: null },
        history: { kind: "unavailable", reason: "provider-unavailable" },
        referrals: accountReferrals,
      });
      expect(warnings(output)).toContain(
        "account.reservation-history.unavailable"
      );
      expect(output.join("\n")).not.toContain("configuration broken");
    });

    test("degrades a review account's history alone when its capability can't be built", async () => {
      currentStanding = standing({ kind: "review" });
      layerOverrides = { history: unbuildableHistory };

      await expect(loadPageState()).resolves.toEqual({
        kind: "review-account",
        deletion: "withheld",
        assistants: [],
        email: customerEmail,
        history: { kind: "unavailable", reason: "provider-unavailable" },
      });
    });

    test("keeps the session's sections when the profile capability can't be built", async () => {
      passkeysFlag.mockResolvedValue(true);
      layerOverrides = {
        profile: Layer.effect(CustomerProfileService, failConfiguration),
      };

      const { state, output } = await loadWithWarnings();

      expect(state).toEqual({
        kind: "authenticated-unavailable",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
        passkeys: { accountId, passkeys: [accountPasskey] },
      });
      expect(output.join("\n")).toContain("Account profile load failed");
    });

    test("keeps the session's sections when the standing's links can't be built", async () => {
      layerOverrides = {
        currentAccount: Layer.effect(
          CurrentCustomerAccount,
          Effect.die(invalidConfiguration)
        ),
      };

      const { state, output } = await loadWithWarnings("RFL12345");

      expect(state).toEqual({
        kind: "authenticated-unavailable",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
      });
      const logged = output.join("\n");
      expect(logged).toContain("Account resolution failed");
      expect(logged).toContain("account-link.lock");
      expect(logged).not.toContain("configuration broken");
      expect(profileLoadCalls).toBe(0);
    });

    test("keeps the linked page without referral state when the referral capability can't be built", async () => {
      currentStanding = standing({
        kind: "linked",
        customerId: "60111",
        autoLinked: true,
      });
      storedSignupIntent = unsettledIntent;
      layerOverrides = { referrals: unbuildableReferrals };

      const { state, output } = await loadWithWarnings("RFL12345");

      expect(state).toEqual({
        kind: "linked",
        deletion: "offered",
        assistants: [],
        referralsEnabled: true,
        email: customerEmail,
        profile: {
          firstName: "Ada",
          lastName: "Lovelace",
          phone: null,
          billing: null,
        },
        avatar: { kind: "available", avatar: null },
        history: {
          kind: "available",
          groups: { current: [], past: [], unavailable: [] },
        },
      });
      const logged = warnings(output);
      for (const code of [
        "account.auto-link.referral.unavailable",
        "account.signup-referral.unavailable",
        "referrals.remembered-referral.unavailable",
        "account.referrals.unavailable",
      ]) {
        expect(logged).toContain(code);
      }
      expect(output.join("\n")).not.toContain("configuration broken");
      expect(acceptReferralCalls).toEqual([]);
      expect(storedSignupIntent).toEqual(unsettledIntent);
    });

    test("offers profile completion without a prefill when the referral capability can't be built", async () => {
      currentStanding = standing({ kind: "profile-missing" });
      layerOverrides = { referrals: unbuildableReferrals };

      const { state, output } = await loadWithWarnings("RFL12345");

      expect(state).toEqual({
        kind: "completion-required",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
        referralsEnabled: true,
      });
      expect(warnings(output)).toContain("account.referral-code.unavailable");
      expect(availableReferralCodeCalls).toEqual([]);
    });
    test("fails every account flag closed when the flag capability can't load", async () => {
      passkeysFlag.mockResolvedValue(true);
      layerOverrides = {
        passkeyRelease: Layer.effect(PasskeyReleaseGate, unloadable),
        avatarRelease: Layer.effect(AccountAvatarReleaseGate, unloadable),
      };

      await expect(loadPageState()).resolves.toMatchObject({
        kind: "linked",
        avatar: { kind: "hidden" },
      });
      expect(passkeyListCalls).toBe(0);
      expect(avatarLookupCalls).toBe(0);
    });

    test("fails a flag closed when its evaluation dies", async () => {
      passkeysFlag.mockResolvedValue(true);
      layerOverrides = {
        passkeyRelease: PasskeyReleaseGate.fromEvaluation(
          Effect.die(new Error("evaluation crashed"))
        ),
        avatarRelease: AccountAvatarReleaseGate.fromEvaluation(
          Effect.die(new Error("evaluation crashed"))
        ),
      };

      const state = await loadPageState();

      expect(state).toMatchObject({
        kind: "linked",
        avatar: { kind: "hidden" },
      });
      expect(state).not.toHaveProperty("passkeys");
    });

    test("keeps a pending deletion whole when the assistants capability can't load", async () => {
      currentStanding = standing({ kind: "deletion-pending" });
      layerOverrides = {
        assistants: Layer.effect(CustomerAgentConnections, unloadable),
      };

      await expect(loadPageState()).resolves.toEqual({
        kind: "deletion-pending",
        deletion: "pending",
        email: customerEmail,
      });
    });
    test("degrades only the sections whose capabilities die while building", async () => {
      layerOverrides = {
        avatar: Layer.effect(CustomerAvatarService, unloadable),
        history: Layer.effect(CustomerReservationHistoryService, unloadable),
      };

      const { state, output } = await loadWithWarnings();

      expect(state).toMatchObject({
        kind: "linked",
        profile: { firstName: "Ada" },
        avatar: { kind: "available", avatar: null },
        history: { kind: "unavailable", reason: "provider-unavailable" },
        referrals: accountReferrals,
      });
      const logged = warnings(output);
      expect(logged).toContain("account.avatar.unavailable");
      expect(logged).toContain("account.reservation-history.unavailable");
      expect(output.join("\n")).not.toContain("module failed to load");
    });

    test("degrades a section whose read dies", async () => {
      historyEffect = Effect.die(new Error("history crashed"));

      const { state, output } = await loadWithWarnings();

      expect(state).toMatchObject({
        kind: "linked",
        history: { kind: "unavailable", reason: "provider-unavailable" },
      });
      expect(warnings(output)).toContain(
        "account.reservation-history.unavailable"
      );
      expect(output.join("\n")).not.toContain("history crashed");
    });

    test("keeps the session's sections when the profile capability dies while building", async () => {
      layerOverrides = {
        profile: Layer.effect(CustomerProfileService, unloadable),
      };

      await expect(loadPageState()).resolves.toEqual({
        kind: "authenticated-unavailable",
        deletion: "offered",
        assistants: [],
        email: customerEmail,
      });
    });
    test("degrades the signup referral before reading a settled outcome when the referral capability can't be built", async () => {
      storedSignupIntent = { ...unsettledIntent, outcome: "applied" };
      layerOverrides = { referrals: unbuildableReferrals };

      const { state, output } = await loadWithWarnings();

      expect(state).toMatchObject({ kind: "linked" });
      expect(state).not.toHaveProperty("signupReferral");
      expect(warnings(output)).toContain("account.signup-referral.unavailable");
    });

    test("logs the auto-link acceptance as unavailable without an auto-link when the referral capability can't be built", async () => {
      layerOverrides = { referrals: unbuildableReferrals };

      const { state, output } = await loadWithWarnings();

      expect(state).toMatchObject({ kind: "linked" });
      expect(warnings(output)).toContain(
        "account.auto-link.referral.unavailable"
      );
    });

    test("lets Next.js control flow from a section reach Next.js", async () => {
      historyEffect = Effect.sync(() => redirect("/target"));

      await expect(loadPageState()).rejects.toThrow("NEXT_REDIRECT");
    });
    describe("with Next.js control flow beside a typed failure", () => {
      const redirectError = Effect.runSync(
        Effect.flip(
          Effect.try({
            try: () => redirect("/target"),
            catch: (thrown) => thrown,
          })
        )
      );
      const failBesideRedirect = <E>(failure: E) =>
        Effect.failCause(
          Cause.combine(Cause.fail(failure), Cause.die(redirectError))
        );
      const loadExit = () =>
        Effect.runPromiseExit(
          loadAccountPageState.pipe(Effect.provide(pageLayer()))
        );

      test("keeps the control flow of a section read", async () => {
        historyEffect = failBesideRedirect(databaseOutage);

        const exit = await loadExit();

        expect(exit._tag === "Failure" && findNextControlFlow(exit.cause)).toBe(
          redirectError
        );
      });

      test("keeps the control flow of a capability that failed to build", async () => {
        layerOverrides = {
          history: Layer.effect(
            CustomerReservationHistoryService,
            failBesideRedirect(invalidConfiguration)
          ),
        };

        const exit = await loadExit();

        expect(exit._tag === "Failure" && findNextControlFlow(exit.cause)).toBe(
          redirectError
        );
      });

      test("keeps the control flow of the resolution", async () => {
        currentStanding = failBesideRedirect(profileFailure);

        const exit = await loadExit();

        expect(exit._tag === "Failure" && findNextControlFlow(exit.cause)).toBe(
          redirectError
        );
      });
    });
  });
});
