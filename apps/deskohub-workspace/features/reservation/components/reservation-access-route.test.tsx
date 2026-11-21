import "@/shared/polyfills/temporal";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { prerender } from "react-dom/static";
import { type OrderKind, orderIdSchema } from "@/features/order";
import { getUnlimitedAccessCookieName } from "@/features/passes/backend/unlimited-access-capability";
import type { UnlimitedAccessView } from "@/features/passes/unlimited-access";
import { getReservationAccessCookieName } from "@/features/reservation/backend/reservation-access-cookie";
import { getReservationInvitationCookieName } from "@/features/reservation/backend/reservation-invitation-capability";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { plainDateStringSchema } from "@/shared/utils/temporal";

mock.module("server-only", () => ({}));
const nextServer = await import("next/server");
mock.module("next/server", () => ({
  ...nextServer,
  connection: () => Promise.resolve(),
}));
mock.module("next/root-params", () => ({
  locale: () => Promise.resolve("en-US"),
}));

/** What `notFound` throws. */
class NotFoundSignal extends Error {}
class RedirectSignal extends Error {}
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  notFound: () => {
    throw new NotFoundSignal("Not found");
  },
  redirect: (path: string) => {
    throw new RedirectSignal(path);
  },
}));

const nextHeaders = await import("next/headers");
const requestCookies = new Map<string, string>();
mock.module("next/headers", () => ({
  ...nextHeaders,
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = requestCookies.get(name);
        return value === undefined ? undefined : { value };
      },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

let orderKind: OrderKind | undefined = "reservation";
const orderKindReads: string[] = [];
mock.module("@/features/order/backend/order-kind", () => ({
  loadOrderKind: async (id: string) => {
    orderKindReads.push(id);
    return orderKind;
  },
}));

let passesEnabled = false;
let unlimitedAccess: UnlimitedAccessView | { state: "sign-in" | "not-found" } =
  {
    state: "not-found",
  };
const unlimitedReads: Array<{ id: string; cookie?: string }> = [];
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    isCoworkPassesPageOpenAfterConnection: async () => passesEnabled,
  })
);
mock.module("@/features/passes/backend/unlimited-access", () => ({
  loadUnlimitedAccessPage: async (
    id: string,
    _headers: Headers,
    cookie?: string
  ) => {
    unlimitedReads.push({ id, cookie });
    return unlimitedAccess;
  },
}));

const accessReads: string[] = [];
const readAccessCookies: Array<{
  accessCookie?: string;
  invitationCookie?: string;
}> = [];
const accessService = {
  getAccess: ({
    orderId,
    accessCookie,
    invitationCookie,
  }: {
    readonly orderId: string;
    readonly accessCookie?: string;
    readonly invitationCookie?: string;
  }) =>
    Effect.sync(() => {
      accessReads.push(orderId);
      readAccessCookies.push({ accessCookie, invitationCookie });
      return { state: "unavailable" };
    }),
};
class ReservationAccessService extends Context.Service<
  ReservationAccessService,
  typeof accessService
>()("@deskohub-workspace/reservation/ReservationAccessService") {
  static Live = Layer.succeed(this, accessService);
}
mock.module(
  "@/features/reservation/backend/reservation-access.service",
  () => ({
    ReservationAccessService,
  })
);

mock.module(
  "@/features/reservation/components/reservation-access-page",
  () => ({
    ReservationAccessPage: ({
      access,
      orderId,
    }: {
      readonly access: { readonly state: string };
      readonly orderId: string;
    }) => <section data-access={access.state} data-order={orderId} />,
  })
);

const { ReservationAccessRoute } = await import("./reservation-access-route");

const orderId = workspaceReservationIdSchema.make("reservation-access-route");
const passOrderId = orderIdSchema.make("01900000-0000-7000-8000-000000000014");

const renderRoute = async (order: string = orderId) => {
  const errors: unknown[] = [];
  const { prelude } = await prerender(
    await ReservationAccessRoute({
      params: Promise.resolve({ orderId: order }),
    }),
    {
      onError: (error) => {
        errors.push(error);
      },
    }
  );
  return { errors, html: await new Response(prelude).text() };
};

describe("ReservationAccessRoute", () => {
  afterEach(() => {
    orderKind = "reservation";
    orderKindReads.length = 0;
    accessReads.length = 0;
    readAccessCookies.length = 0;
    requestCookies.clear();
    passesEnabled = false;
    unlimitedReads.length = 0;
    unlimitedAccess = { state: "not-found" };
  });

  test("serves the reservation access page for a reservation order", async () => {
    const { errors, html } = await renderRoute();

    expect(errors).toEqual([]);
    expect(orderKindReads).toEqual([orderId]);
    expect(accessReads).toEqual([orderId]);
    expect(html).toContain(`data-order="${orderId}"`);
  });

  test("serves the reservation access page for an order id no order has", async () => {
    orderKind = undefined;

    const { errors, html } = await renderRoute();

    expect(errors).toEqual([]);
    expect(accessReads).toEqual([orderId]);
    expect(html).toContain('data-access="unavailable"');
  });

  test("passes both access cookies for this reservation to authorization", async () => {
    requestCookies.set(
      getUnlimitedAccessCookieName(passOrderId),
      "synthetic-pass-cookie"
    );
    requestCookies.set(
      getReservationAccessCookieName(orderId),
      "synthetic-owner-cookie"
    );
    requestCookies.set(
      getReservationInvitationCookieName(orderId),
      "synthetic-invitee-cookie"
    );
    const otherOrderId = workspaceReservationIdSchema.make("another-order");
    requestCookies.set(
      getReservationInvitationCookieName(otherOrderId),
      "unrelated-invitee-cookie"
    );
    const { errors } = await renderRoute();

    expect(errors).toEqual([]);
    expect(readAccessCookies).toEqual([
      {
        accessCookie: "synthetic-owner-cookie",
        invitationCookie: "synthetic-invitee-cookie",
      },
    ]);
  });

  test("answers a pass purchase order with not found while passes are disabled", async () => {
    orderKind = "pass-purchase";

    const { errors } = await renderRoute(passOrderId);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFoundSignal);
    expect(accessReads).toEqual([]);
    expect(unlimitedReads).toEqual([]);
  });

  test("renders the Unlimited purchase access route without consulting ordinary reservation authorization", async () => {
    orderKind = "pass-purchase";
    passesEnabled = true;
    requestCookies.set(
      getUnlimitedAccessCookieName(passOrderId),
      "synthetic-pass-cookie"
    );
    requestCookies.set(
      getReservationAccessCookieName(passOrderId),
      "synthetic-reservation-cookie"
    );
    unlimitedAccess = {
      state: "available",
      tier: "reserved-desk",
      validFrom: plainDateStringSchema.make("2030-03-29"),
      validUntil: plainDateStringSchema.make("2030-04-28"),
      date: Temporal.PlainDate.from("2030-03-31"),
      day: 3,
      continuesTomorrow: true,
      endsAt: Temporal.Instant.from("2030-03-31T22:00Z"),
      deskLabel: "Desk 14",
      code: "246813579",
    };

    const { errors, html } = await renderRoute(passOrderId);

    expect(errors).toEqual([]);
    expect(unlimitedReads).toEqual([
      { id: passOrderId, cookie: "synthetic-pass-cookie" },
    ]);
    expect(accessReads).toEqual([]);
    expect(html).toContain("Today’s door code");
    expect(html).toContain("Day 3 of 30");
    expect(html).toContain("Desk 14");
    expect(html).toContain("until midnight");
  });

  test("continues sign-in to the same pass access URL", async () => {
    orderKind = "pass-purchase";
    passesEnabled = true;
    unlimitedAccess = { state: "sign-in" };

    const { errors } = await renderRoute(passOrderId);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RedirectSignal);
    const redirectPath = new URL(
      (errors[0] as Error).message,
      "https://example.invalid"
    );
    expect(redirectPath.pathname).toEqual("/en-US/auth/sign-in");
    expect(redirectPath.searchParams.get("returnTo")).toEqual(
      `/en-US/reservation/access/${passOrderId}`
    );
    expect(accessReads).toEqual([]);
  });

  test("answers an invalid order id with not found before reading the order", async () => {
    const { errors } = await renderRoute("");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFoundSignal);
    expect(orderKindReads).toEqual([]);
    expect(accessReads).toEqual([]);
  });
});
