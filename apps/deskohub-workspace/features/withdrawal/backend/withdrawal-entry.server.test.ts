import { testEmailAddress } from "@deskohub/test-email";
import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer, Option } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import type { Money } from "@/shared/money/money";
import type { WithdrawalQuote } from "../withdrawal-read-model";
import { contractWithdrawalFixture } from "./contract-withdrawal.test-utils";
import { WithdrawalRepository } from "./withdrawal.repository";
import {
  WithdrawalRefusedError,
  WithdrawalService,
} from "./withdrawal.service";
import { WithdrawalReleaseGate } from "./withdrawal-release-gate";

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
  readonly accountId: string;
  readonly email: string;
  readonly deletionRequested: boolean;
};
let currentUser: TestUser | null = null;
const Authentication = Context.Service<
  Authentication,
  { readonly currentUser: Effect.Effect<TestUser | null> }
>()("@test/WithdrawalEntryAuthentication");
Object.assign(Authentication, {
  Default: Layer.effect(
    Authentication,
    Effect.succeed({
      get currentUser() {
        return Effect.succeed(currentUser);
      },
    })
  ),
});
mock.module(
  "@/features/account/backend/customer-authentication.service",
  () => ({ CustomerAuthentication: Authentication })
);

const refund: Money = { value: 40_000, exponent: 2, currency: "CZK" };
const periodEndsAt = Temporal.Instant.from("2027-01-24T08:00:00Z");

const quote: WithdrawalQuote = {
  contractId: "reservation-1",
  contractLabel: "Synthetic reservation",
  customerName: null,
  receiptEmail: testEmailAddress("customer"),
  paidAmount: refund,
  refundAmount: refund,
  refundBasis: { kind: "full" },
  refundTermsKey: "full",
  periodEndsAt,
};
const calls: string[] = [];
// The recorded withdrawal's refund, `"unreadable"` for a failing ledger.
let recorded: typeof refund | "unreadable" | undefined;
let quotable = true;

Object.assign(WithdrawalRepository, {
  Live: Layer.mock(WithdrawalRepository, {
    findByContract: (contract) =>
      Effect.suspend(() => {
        calls.push(`find ${contract.id}`);
        if (recorded === "unreadable") {
          return Effect.fail(
            new EffectDrizzleQueryError({
              query: "select",
              params: [],
              cause: new Error("ledger unavailable"),
            })
          );
        }
        return Effect.succeed(
          recorded
            ? Option.some(
                contractWithdrawalFixture({
                  accountId: customerAccountIdSchema.make("@test/account-id"),
                  refundAmount: recorded,
                })
              )
            : Option.none()
        );
      }),
  }),
});
Object.assign(WithdrawalService, {
  Live: Layer.mock(WithdrawalService, {
    quote: (input) =>
      Effect.suspend(() => {
        calls.push(`quote ${input.contract.id}`);
        return quotable
          ? Effect.succeed(quote)
          : Effect.fail(new WithdrawalRefusedError({ reason: "period_ended" }));
      }),
  }),
});

const reservationId = workspaceReservationIdSchema.make("reservation-1");
const readEntry = async () => {
  const { readReservationWithdrawalEntry } = await import(
    "./withdrawal-entry.server"
  );
  return Effect.runPromise(
    readReservationWithdrawalEntry({ reservationId, locale: "en-US" })
  );
};

const reset = () => {
  released = true;
  passesReleased = true;
  currentUser = {
    accountId: "@test/account-id",
    email: testEmailAddress("customer"),
    deletionRequested: false,
  };
  recorded = undefined;
  quotable = true;
  calls.length = 0;
};

describe("readReservationWithdrawalEntry", () => {
  beforeEach(reset);

  test("shows a recorded withdrawal with its refund", async () => {
    recorded = refund;
    quotable = false;

    expect(await readEntry()).toEqual({
      status: "withdrawn",
      refundAmount: refund,
    });
  });

  test("shows a recorded withdrawal to a signed-out viewer after the function closed", async () => {
    recorded = refund;
    released = false;
    currentUser = null;

    expect(await readEntry()).toEqual({
      status: "withdrawn",
      refundAmount: refund,
    });
  });

  test("offers the withdrawal while the customer's quote is available", async () => {
    expect(await readEntry()).toEqual({ status: "offered" });
    expect(calls.toSorted()).toEqual([
      "find reservation-1",
      "quote reservation-1",
    ]);
  });

  test("offers nothing when the quote is refused", async () => {
    quotable = false;

    expect(await readEntry()).toEqual({ status: "none" });
  });

  test("offers nothing and makes no quote while the function is closed", async () => {
    released = false;

    expect(await readEntry()).toEqual({ status: "none" });
    expect(calls).toEqual(["find reservation-1"]);
  });

  test("falls back to the offer when the ledger can't be read", async () => {
    recorded = "unreadable";

    expect(await readEntry()).toEqual({ status: "offered" });
  });
});

describe("readPassWithdrawalEntry", () => {
  beforeEach(reset);

  const id = orderIdSchema.make(crypto.randomUUID());
  const readPassEntry = async (offerWithdrawal = true) => {
    const { readPassWithdrawalEntry } = await import(
      "./withdrawal-entry.server"
    );
    return Effect.runPromise(
      readPassWithdrawalEntry({
        contract: { kind: "entry-pack", id },
        locale: "cs-CZ",
        offerWithdrawal,
      })
    );
  };

  test("requires both gates and a quote for a new offer", async () => {
    released = false;
    expect(await readPassEntry()).toEqual({ status: "none" });
    released = true;
    passesReleased = false;
    expect(await readPassEntry()).toEqual({ status: "none" });
    expect(calls).toEqual([`find ${id}`, `find ${id}`]);

    passesReleased = true;
    expect(await readPassEntry()).toEqual({ status: "offered" });
    expect(calls.slice(-2)).toEqual([`find ${id}`, `quote ${id}`]);
  });

  test("only the buyer can see the recorded refund while the gates are closed", async () => {
    recorded = refund;
    released = false;
    passesReleased = false;
    expect(await readPassEntry(false)).toEqual({
      status: "withdrawn",
      refundAmount: refund,
    });

    currentUser = {
      accountId: "@test/holder-id",
      email: testEmailAddress("holder"),
      deletionRequested: false,
    };
    expect(await readPassEntry(false)).toEqual({ status: "none" });
    currentUser = null;
    expect(await readPassEntry(false)).toEqual({ status: "none" });
    expect(calls).toEqual([`find ${id}`, `find ${id}`, `find ${id}`]);
  });
});
