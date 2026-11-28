import { testEmailAddress } from "@deskohub/test-email";
import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Context, Effect, Layer, Schema } from "effect";
import { m } from "@/features/i18n";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import {
  WithdrawalNameRequiredError,
  WithdrawalRefundChangedError,
  WithdrawalService,
} from "@/features/withdrawal/backend/withdrawal.service";
import { WithdrawalReleaseGate } from "@/features/withdrawal/backend/withdrawal-release-gate";
import { withdrawalIdSchema } from "@/features/withdrawal/withdrawal-identifiers";
import { mockWorkspaceActionRequest } from "@/shared/testing/workspace-action-request.test-utils";

await mockWorkspaceActionRequest();

// The request's release decision for the online withdrawal function.
let released = true;
mock.module(
  "@/features/withdrawal/backend/withdrawal-release-gate.server",
  () => ({
    WithdrawalReleaseGateRequest: WithdrawalReleaseGate.fromEvaluation(
      Effect.suspend(() => Effect.succeed(released))
    ),
  })
);

let passesReleased = true;
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    CoworkPassesReleaseGateRequest: CoworkPassesReleaseGate.fromEvaluation(
      Effect.suspend(() => Effect.succeed(passesReleased))
    ),
  })
);

type TestUser = {
  readonly accountId: "@test/account-id";
  readonly email: string;
  readonly deletionRequested: boolean;
};
let currentUser: Effect.Effect<TestUser | null> = Effect.succeed({
  accountId: "@test/account-id",
  email: testEmailAddress("customer"),
  deletionRequested: false,
});
const Authentication = Context.Service<
  Authentication,
  { readonly currentUser: Effect.Effect<TestUser | null> }
>()("@test/WithdrawalActionsAuthentication");
Object.assign(Authentication, {
  Default: Layer.effect(
    Authentication,
    Effect.succeed({
      get currentUser() {
        return currentUser;
      },
    })
  ),
});
mock.module(
  "@/features/account/backend/customer-authentication.service",
  () => ({ CustomerAuthentication: Authentication })
);

const calls: string[] = [];
const contractKinds: string[] = [];
const withdrawalId = Schema.decodeSync(withdrawalIdSchema)("withdrawal-1");
// Whether the mocked profile has a name for the statement.
let profileNamed = true;
const paid = { value: 300_000, exponent: 2, currency: "CZK" };
const makeQuote = (contractId: string) => ({
  contractId,
  contractLabel: "Office · 10.–12. 1. 2027",
  customerName: null,
  receiptEmail: testEmailAddress("customer"),
  paidAmount: paid,
  refundAmount: paid,
  refundBasis: { kind: "full" } as const,
  refundTermsKey: "full",
  periodEndsAt: Temporal.Instant.from("2027-01-16T23:00:00Z"),
});
Object.assign(WithdrawalService, {
  Live: Layer.mock(WithdrawalService, {
    quote: (input) =>
      Effect.sync(() => {
        contractKinds.push(input.contract.kind);
        calls.push(`quote ${input.accountId} ${input.contract.id}`);
        return makeQuote(input.contract.id);
      }),
    withdraw: (input) =>
      Effect.gen(function* () {
        contractKinds.push(input.contract.kind);
        calls.push(
          `withdraw ${input.accountId} ${input.contract.id}${input.customerName === undefined ? "" : ` as ${input.customerName}`}`
        );
        if (input.refundTermsKey === "stale") {
          return yield* new WithdrawalRefundChangedError({
            quote: makeQuote(input.contract.id),
          });
        }
        if (!profileNamed && !input.customerName?.trim()) {
          return yield* new WithdrawalNameRequiredError();
        }
        return {
          withdrawalId,
          submittedAt: Temporal.Instant.from("2027-01-10T08:00:00Z"),
          refundAmount: paid,
          receiptEmail: testEmailAddress("customer"),
        };
      }),
  }),
});

const reservation = { kind: "reservation", orderId: "reservation-1" } as const;

const importActions = () => import("./withdrawal-actions");

describe("withdrawal actions", () => {
  beforeEach(() => {
    released = true;
    passesReleased = true;
    profileNamed = true;
    calls.length = 0;
    contractKinds.length = 0;
    currentUser = Effect.succeed({
      accountId: "@test/account-id",
      email: testEmailAddress("customer"),
      deletionRequested: false,
    });
  });

  test("refuse as unavailable while the function isn't released, before any withdrawal work", async () => {
    released = false;
    const { quoteContractWithdrawal, withdrawFromContract } =
      await importActions();

    const quote = await quoteContractWithdrawal({
      contract: reservation,
    });
    const withdrawal = await withdrawFromContract({
      contract: reservation,
    });

    const unavailable = m.accountUnavailableDescription(
      {},
      { locale: "en-US" }
    );
    expect(quote.serverError).toBe(unavailable);
    expect(withdrawal.serverError).toBe(unavailable);
    expect(calls).toEqual([]);
  });

  test("quote and withdraw for the session's account while released", async () => {
    const { quoteContractWithdrawal, withdrawFromContract } =
      await importActions();

    const quote = await quoteContractWithdrawal({
      contract: reservation,
    });
    const withdrawal = await withdrawFromContract({
      contract: reservation,
    });

    expect(quote.data).toMatchObject({
      status: "available",
      quote: { periodEndsAt: "2027-01-16T23:00:00Z" },
    });
    expect(withdrawal.data).toEqual({
      status: "withdrawn",
      receipt: {
        withdrawalId,
        submittedAt: "2027-01-10T08:00:00Z",
        refundAmount: paid,
        receiptEmail: testEmailAddress("customer"),
      },
    });
    expect(calls).toEqual([
      "quote @test/account-id reservation-1",
      "withdraw @test/account-id reservation-1",
    ]);
  });

  test.each(["entry-pack", "unlimited-pass"] as const)(
    "quotes and submits %s for the session account only while both gates are open",
    async (kind) => {
      const { quoteContractWithdrawal, withdrawFromContract } =
        await importActions();
      const orderId = crypto.randomUUID();
      const contract = { kind, orderId };
      const unavailable = m.accountUnavailableDescription(
        {},
        { locale: "en-US" }
      );

      released = false;
      expect((await quoteContractWithdrawal({ contract })).serverError).toBe(
        unavailable
      );
      expect((await withdrawFromContract({ contract })).serverError).toBe(
        unavailable
      );

      released = true;
      passesReleased = false;
      expect((await quoteContractWithdrawal({ contract })).serverError).toBe(
        unavailable
      );
      expect((await withdrawFromContract({ contract })).serverError).toBe(
        unavailable
      );
      expect(calls).toEqual([]);

      passesReleased = true;
      const quote = await quoteContractWithdrawal({ contract });
      expect(quote.data).toMatchObject({ status: "available" });
      const result = await withdrawFromContract({
        contract,
        refundTermsKey: "full",
      });
      expect(result.data).toMatchObject({ status: "withdrawn" });
      expect(contractKinds).toEqual([kind, kind]);
      expect(calls).toEqual([
        `quote @test/account-id ${orderId}`,
        `withdraw @test/account-id ${orderId}`,
      ]);
    }
  );

  test("pass the typed name to the withdrawal", async () => {
    profileNamed = false;
    const { withdrawFromContract } = await importActions();

    const withdrawal = await withdrawFromContract({
      contract: reservation,
      customerName: "Sam Typed",
    });

    expect(withdrawal.data).toMatchObject({ status: "withdrawn" });
    expect(calls).toEqual([
      "withdraw @test/account-id reservation-1 as Sam Typed",
    ]);
  });

  test("answer that the statement needs a name when neither the profile nor the customer gave one", async () => {
    profileNamed = false;
    const { withdrawFromContract } = await importActions();

    const withdrawal = await withdrawFromContract({
      contract: reservation,
    });

    expect(withdrawal.data).toEqual({ status: "name_required" });
  });

  test("returns a fresh quote when the submitted refund terms changed", async () => {
    const { withdrawFromContract } = await importActions();
    const result = await withdrawFromContract({
      contract: reservation,
      refundTermsKey: "stale",
    });
    expect(result.data).toMatchObject({
      status: "refund_changed",
      quote: { refundTermsKey: "full", periodEndsAt: "2027-01-16T23:00:00Z" },
    });
  });

  test("refuse a signed-out request without touching withdrawals", async () => {
    currentUser = Effect.succeed(null);
    const { withdrawFromContract } = await importActions();

    const withdrawal = await withdrawFromContract({
      contract: reservation,
    });

    expect(withdrawal.serverError).toBeString();
    expect(calls).toEqual([]);
  });
});
