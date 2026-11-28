import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { testEmailAddress } from "@deskohub/test-email";
import { Data, Effect, Layer, Option, type Schema } from "effect";
import type { CustomerAgentScope } from "@/features/account";
import {
  type CustomerAgentGrant,
  customerAgentClientIdSchema,
} from "@/features/account/backend/auth/customer-agent-authorization.service";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import type { prepareAgentPayState as PrepareAgentPayState } from "@/features/reservation/backend/agent-booking";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { atInstant } from "@/shared/testing/workspace-test-clock.test-utils";

type Prepared =
  | { readonly status: "ready" | "pricing_changed" }
  | { readonly status: "error" }
  | { readonly fail: { readonly _tag: string } };

/** Each booking request the tool made through the agent entry point. */
const requests: Parameters<typeof PrepareAgentPayState>[0][] = [];
let prepared: Prepared = { status: "ready" };

const { AgentBookingPaymentInProgressError } = await import(
  "@/features/reservation/backend/booking-agent"
);
const agentBookingModule = await import(
  "@/features/reservation/backend/agent-booking"
);
mock.module("@/features/reservation/backend/agent-booking", () => ({
  ...agentBookingModule,
  prepareAgentPayState: (request: Parameters<typeof PrepareAgentPayState>[0]) =>
    Effect.sync(() => requests.push(request)).pipe(
      Effect.flatMap(() =>
        "fail" in prepared
          ? Effect.fail(prepared.fail)
          : Effect.succeed(
              prepared.status === "error"
                ? { status: "error" as const, message: "Conflict" }
                : {
                    status: prepared.status,
                    orderId: "order-1",
                    redirectUrl: `/${request.locale}/checkout/pay?payState=sealed&orderId=order-1`,
                    expiresAt: "2099-01-01T10:10:00.000Z",
                    affectedProductKeys: [],
                  }
            )
      )
    ),
}));

type Contact = {
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
} | null;
let contact: Contact;

const {
  inMemoryCustomerAgentCallServices,
  makeAgentToolTestServices,
  workspaceDateFromToday,
} = await import("./agent-tools.test-utils");
const { startReservationTool } = await import("./start-reservation.tool");

const callerServices = inMemoryCustomerAgentCallServices(({ accountId }) => ({
  contact: {
    current: Effect.sync(() => (contact ? { accountId, ...contact } : null)),
  },
}));

const grantFor = (clientId: string): CustomerAgentGrant => ({
  accountId: customerAccountIdSchema.make("account-1"),
  clientId: customerAgentClientIdSchema.make(clientId),
  scopes: new Set<CustomerAgentScope>(["reservations:create"]),
});

const assistant = "https://assistant.example/client.json";

const start = (
  args: Schema.Json,
  {
    clientId = assistant,
    now = Temporal.Now.instant(),
    services = makeAgentToolTestServices(),
  }: {
    readonly clientId?: string;
    readonly now?: Temporal.Instant;
    readonly services?: ReturnType<typeof makeAgentToolTestServices>;
  } = {}
) =>
  startReservationTool
    .call(args, Option.some({ grant: grantFor(clientId), accessToken: "t" }))
    .pipe(
      Effect.provide(Layer.merge(services.layer, callerServices)),
      atInstant(now),
      Effect.result,
      Effect.runPromise
    );

const cowork = (days = 2) => ({
  family: "cowork",
  date: workspaceDateFromToday(days),
  tier: "open-space",
});

class WorkspaceTableUnavailableError extends Data.TaggedError(
  "WorkspaceTableUnavailableError"
)<Record<string, never>> {}

class SchemaError extends Data.TaggedError("SchemaError")<
  Record<string, never>
> {}

describe("start_reservation", () => {
  beforeEach(() => {
    requests.length = 0;
    prepared = { status: "ready" };
    contact = {
      name: "Ada Agent",
      email: testEmailAddress("start-reservation"),
      phone: "+420 777 123 456",
    };
  });

  test("starts a Team Table hold for the exact selection while the gate is open", async () => {
    const date = workspaceDateFromToday(2);
    const selection = {
      family: "table",
      date,
      seats: 4,
      start_time: "09:15",
      end_time: "10:45",
    };

    const closed = await start(selection);
    expect(closed).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "unsupported_family" } },
    });
    expect(requests).toEqual([]);

    const result = await start(selection, {
      services: makeAgentToolTestServices({
        teamTableEnabled: true,
        teamTableSizes: [4],
      }),
    });
    expect(result).toMatchObject({
      _tag: "Success",
      success: { family: "table", total: { amount: 360, currency: "CZK" } },
    });
    expect(requests).toMatchObject([
      {
        reservation: { kind: "table", seats: 4 },
      },
    ]);
    const reservation = requests[0]?.reservation;
    if (reservation?.kind !== "table")
      throw new Error("Expected a Team Table hold");
    expect(
      Temporal.Instant.from(reservation.startsAt)
        .toZonedDateTimeISO("Europe/Prague")
        .toPlainDateTime()
        .toString({ smallestUnit: "minute" })
    ).toBe(`${date}T09:15`);
    expect(
      Temporal.Instant.from(reservation.endsAt)
        .toZonedDateTimeISO("Europe/Prague")
        .toPlainDateTime()
        .toString({ smallestUnit: "minute" })
    ).toBe(`${date}T10:45`);
  });

  test("holds the selection as the account's own booking and returns the Pay link", async () => {
    const result = await start(cowork());

    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        order_id: "order-1",
        pay_url: expect.stringMatching(
          /^https?:\/\/[^/]+\/en-US\/checkout\/pay\?payState=sealed&orderId=order-1$/
        ),
        pay_url_expires_at: "2099-01-01T10:10:00.000Z",
        family: "cowork",
        total: { amount: 290, currency: "CZK" },
        price_changed: false,
      },
    });
    expect(requests).toMatchObject([
      {
        grant: grantFor(assistant),
        reservation: {
          kind: "cowork",
          entryTier: "open-space",
          date: workspaceDateFromToday(2),
          coffee: false,
        },
        contact: {
          name: "Ada Agent",
          email: testEmailAddress("start-reservation"),
          phone: "+420 777 123 456",
        },
        advertisedPriceToken: expect.any(String),
        marketingConsent: false,
        locale: "en-US",
      },
    ]);
  });

  test.each([
    ["WorkspaceTableUnavailableError", "selection_unavailable"],
    ["TableAssignmentUnavailableError", "selection_unavailable"],
    ["TeamTableReservationsDisabledError", "unsupported_family"],
    ["TeamTableAvailabilityClosed", "unsupported_family"],
  ])("maps %s after a Team Table quote", async (_tag, code) => {
    prepared = { fail: { _tag } };

    const result = await start(
      {
        family: "table",
        date: workspaceDateFromToday(2),
        seats: 4,
        start_time: "09:15",
        end_time: "10:45",
      },
      {
        services: makeAgentToolTestServices({
          teamTableEnabled: true,
          teamTableSizes: [4],
        }),
      }
    );

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { details: { code } },
    });
  });

  test("passes a repeated selection the same way and another selection as its own", async () => {
    await start(cowork());
    await start(cowork());
    await start(cowork(3));
    await start(cowork(), { clientId: "https://other.example/c.json" });

    // Each call seals its own advertised price token.
    const [first, repeat, otherSelection, otherClient] = requests.map(
      ({ advertisedPriceToken: _, ...request }) => request
    );
    assert(first);
    expect(repeat).toEqual(first);
    expect(otherSelection?.reservation).not.toEqual(first?.reservation);
    expect(otherClient?.grant.clientId).toBe(
      customerAgentClientIdSchema.make("https://other.example/c.json")
    );
    expect(otherClient?.reservation).toEqual(first.reservation);
  });

  test("books a meeting room with early setup at the same price under its own selection", async () => {
    const meetingRoom = {
      family: "meeting-room",
      date: workspaceDateFromToday(2),
      start_time: "14:00",
      duration: "hour:1",
    };

    const plain = await start(meetingRoom);
    const declined = await start({ ...meetingRoom, early_setup: false });
    const early = await start({ ...meetingRoom, early_setup: true });

    expect(requests).toHaveLength(3);
    const [plainRequest, declinedRequest, earlyRequest] = requests;
    assert(plainRequest && declinedRequest && earlyRequest);
    expect(plainRequest.reservation).not.toHaveProperty("earlySetup");
    // Declining books the same selection, so the same request.
    expect(declinedRequest.reservation).toEqual(plainRequest.reservation);
    // The booked time stays; only the flag is added, which makes it another
    // selection.
    // The selection gains a field its kind declares only optionally.
    expect<unknown>(earlyRequest.reservation).toEqual({
      ...plainRequest.reservation,
      earlySetup: true,
    });
    const totals = [plain, declined, early].map((result) =>
      result._tag === "Success" ? result.success.total : undefined
    );
    expect(totals[0]).toBeDefined();
    expect(totals).toEqual([totals[0], totals[0], totals[0]]);
  });

  test("refuses early setup for a family without setup time", async () => {
    const result = await start({ ...cowork(), early_setup: true });

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "invalid_input", field: "early_setup" } },
    });
    expect(requests).toHaveLength(0);
  });

  test("asks for marketing consent only when the customer asked for it", async () => {
    await start(cowork());
    await start({ ...cowork(), marketing_consent: false });
    await start({ ...cowork(), marketing_consent: true });

    expect(requests.map(({ marketingConsent }) => marketingConsent)).toEqual([
      false,
      false,
      true,
    ]);
  });

  test.each([
    ["no bookable profile", null],
    [
      "no phone number",
      { name: "Ada Agent", email: testEmailAddress("no-phone"), phone: null },
    ],
  ] as const)(
    "asks the customer to finish a profile with %s on the site",
    async (_, profile) => {
      contact = profile;

      const result = await start(cowork());

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { details: { code: "profile_incomplete" } },
      });
      expect(requests).toEqual([]);
    }
  );

  test("books in the call's locale", async () => {
    await start({ ...cowork(), locale: "de-DE" });

    expect(requests).toMatchObject([
      { locale: "de-DE", contact: { phone: "+420 777 123 456" } },
    ]);
  });

  test("reports a changed price with the Pay link", async () => {
    prepared = { status: "pricing_changed" };

    expect(await start(cowork())).toMatchObject({
      _tag: "Success",
      success: { price_changed: true, order_id: "order-1" },
    });
  });

  test("maps unavailable selection to a refusal", async () => {
    const error = new WorkspaceTableUnavailableError({});
    prepared = { fail: error };

    expect(await start(cowork())).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "selection_unavailable" } },
    });
  });

  test("maps a pending payment to payment_in_progress", async () => {
    prepared = {
      fail: new AgentBookingPaymentInProgressError({
        reservationId: workspaceReservationIdSchema.make("reservation-1"),
      }),
    };

    expect(await start(cowork())).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "payment_in_progress" } },
    });
  });

  test("maps a submission the booking can't accept to an unavailable reservation", async () => {
    prepared = { fail: new SchemaError({}) };

    expect(await start(cowork())).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "reservation_unavailable" } },
    });
  });

  test("maps a lost hold claim to a conflict", async () => {
    prepared = { status: "error" };

    expect(await start(cowork())).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "reservation_conflict" } },
    });
  });

  test("refuses a call without a signed-in caller", async () => {
    const result = await startReservationTool
      .call(cowork())
      .pipe(
        Effect.provide(makeAgentToolTestServices().layer),
        Effect.result,
        Effect.runPromise
      );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { details: { code: "service_unavailable" } },
    });
    expect(requests).toEqual([]);
  });
});
