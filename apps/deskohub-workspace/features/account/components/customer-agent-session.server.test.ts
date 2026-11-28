import { describe, expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Context, Effect, Layer, Schema } from "effect";
import type { CustomerAccountSession } from "@/features/account/backend/customer-authentication.service";
import {
  CustomerAccountAccessError,
  type CustomerAccountAccessFailure,
  customerAccountIdSchema,
} from "@/features/account/customer-account";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";

let currentUser: Effect.Effect<
  CustomerAccountSession | null,
  CustomerAccountAccessError
> = Effect.succeed(null);

class FakeCustomerAuthentication extends Context.Service<
  FakeCustomerAuthentication,
  {
    readonly currentUser: Effect.Effect<
      CustomerAccountSession | null,
      CustomerAccountAccessError
    >;
  }
>()("test/customer-agent-session/CustomerAuthentication") {
  static Default = Layer.succeed(this, {
    currentUser: Effect.suspend(() => currentUser),
  });
}

const authentication = await import(
  "@/features/account/backend/customer-authentication.service"
);
mock.module(
  "@/features/account/backend/customer-authentication.service",
  () => ({
    ...authentication,
    CustomerAuthentication: FakeCustomerAuthentication,
  })
);

const { readCustomerAgentSession } = await import(
  "./customer-agent-session.server"
);

const session = (deletionRequested: boolean): CustomerAccountSession => ({
  accountId: Schema.decodeSync(customerAccountIdSchema)("account-synthetic-1"),
  email: Schema.decodeSync(reservationCustomerEmailSchema)(
    testEmailAddress("synthetic.customer")
  ),
  deletionRequested,
  displayName: null,
  accountCreatedAt: Temporal.Instant.from("2026-11-01T09:00:00Z"),
  accountUpdatedAt: Temporal.Instant.from("2026-11-02T09:00:00Z"),
});

const readWith = (
  read: Effect.Effect<CustomerAccountSession | null, CustomerAccountAccessError>
) => {
  currentUser = read;
  return readCustomerAgentSession("test.customer-agent-session");
};

describe("readCustomerAgentSession", () => {
  test("no session reads as signed out", async () => {
    expect(await readWith(Effect.succeed(null))).toBe("signed-out");
  });

  test("a session reads as signed in unless its deletion is pending", async () => {
    expect(await readWith(Effect.succeed(session(false)))).toBe("signed-in");
    expect(await readWith(Effect.succeed(session(true)))).toBe(
      "deletion-pending"
    );
  });

  test.each([
    "unauthenticated",
    "unverified-email",
  ] satisfies CustomerAccountAccessFailure[])(
    "a %s session counts as signed out",
    async (reason) => {
      expect(
        await readWith(Effect.fail(new CustomerAccountAccessError({ reason })))
      ).toBe("signed-out");
    }
  );

  test.each([
    "not-configured",
    "link-required",
    "unavailable",
  ] satisfies CustomerAccountAccessFailure[])(
    "a %s failure makes the session unavailable",
    async (reason) => {
      expect(
        await readWith(Effect.fail(new CustomerAccountAccessError({ reason })))
      ).toBe("unavailable");
    }
  );
});
