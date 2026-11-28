import "@/shared/polyfills/temporal";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { testEmailAddress } from "@deskohub/test-email";
import { Context, Effect, Layer, Schema } from "effect";
import type { ReactNode } from "react";
import { prerender } from "react-dom/static";
import type { CheckoutStatusViewModel } from "@/features/checkout/backend/checkout";
import { m } from "@/features/i18n";
import type { OrderKind } from "@/features/order";
import { orderIdSchema } from "@/features/order";
import type { EntryPackStatus } from "@/features/passes/backend/entry-pack-status";
import { getReservationAccessCookieName } from "@/features/reservation/backend/reservation-access-cookie";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import type { ContractWithdrawalEntry } from "@/features/withdrawal/withdrawal-read-model";
import { maskEmailAddress } from "@/shared/utils";
import { plainDateStringSchema } from "@/shared/utils/temporal";

mock.module("server-only", () => ({}));
let connections = 0;
const nextServer = await import("next/server");
mock.module("next/server", () => ({
  ...nextServer,
  connection: () => {
    connections += 1;
    return Promise.resolve();
  },
}));
mock.module("next/root-params", () => ({
  locale: () => Promise.resolve("en-US"),
}));

/** What `redirect` throws, carrying where it sends the visitor. */
class RedirectSignal extends Error {
  constructor(readonly location: string) {
    super(`Redirected to ${location}`);
  }
}
/** What `notFound` throws. */
class NotFoundSignal extends Error {}
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  notFound: () => {
    throw new NotFoundSignal("Not found");
  },
  redirect: (location: string) => {
    throw new RedirectSignal(location);
  },
}));

const requestHeaders = new Headers({ "user-agent": "status-route-test" });
const readCookieNames: string[] = [];
const cookieStore = {
  get: (name: string) => {
    readCookieNames.push(name);
    return { name, value: "access-cookie-value" };
  },
};
const nextHeaders = await import("next/headers");
mock.module("next/headers", () => ({
  ...nextHeaders,
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve(requestHeaders),
}));

const statusService = { name: "checkout-status" };
const authorizationService = { name: "reservation-authorization" };

const checkoutBackend = await import("@/features/checkout/backend/checkout");
type StatusPageLoadInput = Parameters<
  typeof checkoutBackend.loadCheckoutStatusPage
>[2];

let loadResult: Effect.Effect<CheckoutStatusViewModel, Error>;
const loadCalls: {
  readonly service: typeof statusService;
  readonly authorization: typeof authorizationService;
  readonly input: StatusPageLoadInput;
}[] = [];
class CheckoutStatusService extends Context.Service<
  CheckoutStatusService,
  typeof statusService
>()("CheckoutStatusService") {
  static Live = Layer.succeed(this, statusService);
}
mock.module("@/features/checkout/backend/checkout", () => ({
  ...checkoutBackend,
  CheckoutStatusService,
  loadCheckoutStatusPage: (
    service: typeof statusService,
    authorization: typeof authorizationService,
    input: StatusPageLoadInput
  ) => {
    loadCalls.push({ service, authorization, input });
    return loadResult;
  },
}));

const authorizationModule = await import(
  "@/features/reservation/backend/reservation-authorization.service"
);
class ReservationAuthorizationService extends Context.Service<
  ReservationAuthorizationService,
  typeof authorizationService
>()("ReservationAuthorizationService") {
  static Live = Layer.succeed(this, authorizationService);
}
mock.module(
  "@/features/reservation/backend/reservation-authorization.service",
  () => ({ ...authorizationModule, ReservationAuthorizationService })
);

const currentAccountModule = await import(
  "@/features/account/backend/current-customer-account"
);
class CurrentCustomerAccount extends Context.Service<
  CurrentCustomerAccount,
  object
>()("CurrentCustomerAccount") {
  static Live = Layer.succeed(this, {});
}
mock.module("@/features/account/backend/current-customer-account", () => ({
  ...currentAccountModule,
  CurrentCustomerAccount,
}));

let signedOut = false;
let signedOutReads = 0;
const signIn = await import(
  "@/features/checkout/backend/checkout/checkout-status-sign-in"
);
mock.module(
  "@/features/checkout/backend/checkout/checkout-status-sign-in",
  () => ({
    ...signIn,
    isStatusViewerSignedOut: () =>
      Effect.sync(() => {
        signedOutReads += 1;
        return signedOut;
      }),
  })
);

// The reservation's withdrawal entry, and the reservations it was read for.
let withdrawalEntry: ContractWithdrawalEntry = { status: "none" };
const withdrawalEntryReads: string[] = [];
let passWithdrawal: ContractWithdrawalEntry = { status: "none" };
const passWithdrawalReads: { kind: string; id: string; offer: boolean }[] = [];
mock.module("@/features/withdrawal/backend/withdrawal-entry.server", () => ({
  readPassWithdrawalEntry: ({
    contract,
    offerWithdrawal,
  }: {
    contract: { kind: string; id: string };
    offerWithdrawal: boolean;
  }) =>
    Effect.sync(() => {
      passWithdrawalReads.push({ ...contract, offer: offerWithdrawal });
      return passWithdrawal;
    }),
  readReservationWithdrawalEntry: (input: { readonly reservationId: string }) =>
    Effect.sync(() => {
      withdrawalEntryReads.push(input.reservationId);
      return withdrawalEntry;
    }),
}));
const { resendReservationInvitation } = await import(
  "@/features/reservation/actions/resend-reservation-invitation"
);
const addReservationInvitees = mock(async () => ({
  status: "added" as const,
  added: 1,
}));
mock.module("@/features/reservation/actions/add-reservation-invitees", () => ({
  addReservationInvitees,
}));
mock.module("@/features/checkout/components/checkout-status-page", () => ({
  CheckoutStatusPage: ({
    addInvitees,
    locale,
    presentation,
    resendInvitation,
    status,
    withdrawal,
  }: {
    readonly addInvitees?: typeof addReservationInvitees;
    readonly locale: string;
    readonly presentation: string;
    readonly resendInvitation?: typeof resendReservationInvitation;
    readonly status: CheckoutStatusViewModel;
    readonly withdrawal?: ContractWithdrawalEntry;
  }) => (
    <article
      data-add-invitees-action={
        addInvitees === addReservationInvitees ? "connected" : undefined
      }
      data-locale={locale}
      data-order={status.orderId}
      data-presentation={presentation}
      data-status={status.status}
      data-withdrawal={withdrawal?.status}
      data-resend-action={
        resendInvitation === resendReservationInvitation
          ? "connected"
          : undefined
      }
    />
  ),
}));
mock.module("@/shared/components/route-auto-refresh", () => ({
  RouteAutoRefresh: ({
    enabled,
    refreshAt,
  }: {
    readonly enabled: boolean;
    readonly refreshAt?: string;
  }) => (
    <meta data-auto-refresh={String(enabled)} data-refresh-at={refreshAt} />
  ),
}));
const referralSettlement = await import(
  "@/features/checkout/components/checkout-status-referral-code-settlement"
);
mock.module(
  "@/features/checkout/components/checkout-status-referral-code-settlement",
  () => ({
    ...referralSettlement,
    CheckoutStatusReferralCodeSettlement: ({
      status,
    }: {
      readonly status: string;
    }) => <i data-referral-settlement={status} />,
  })
);
const paymentWindow = await import(
  "@/features/checkout/components/checkout-payment-window"
);
mock.module("@/features/checkout/components/checkout-payment-window", () => ({
  ...paymentWindow,
  CheckoutPaymentWindowCoordinator: () => <b data-payment-window="" />,
}));
mock.module(
  "@/features/checkout/components/checkout-status-page-skeleton",
  () => ({
    CheckoutStatusPageSkeleton: ({
      presentation,
    }: {
      readonly presentation: string;
    }) => <div data-skeleton={presentation} />,
  })
);
const flowLayout = await import(
  "@/features/checkout/components/checkout-flow-layout"
);
mock.module("@/features/checkout/components/checkout-flow-layout", () => ({
  ...flowLayout,
  CheckoutFlowLayout: ({
    activeStepKey,
    children,
  }: {
    readonly activeStepKey: string;
    readonly children: ReactNode;
  }) => <main data-flow-step={activeStepKey}>{children}</main>,
}));

let orderKind: OrderKind | undefined = "reservation";
const orderKindReads: string[] = [];
mock.module("@/features/order/backend/order-kind", () => ({
  loadOrderKind: async (id: string) => {
    orderKindReads.push(id);
    return orderKind;
  },
}));

const passOrderId = orderIdSchema.make("1d3c5b87-dedf-47dd-8e46-bf4923fc9662");
const passOrder = {
  orderId: passOrderId,
  tier: "open-space",
  entryCount: 5,
} as const;
let passStatus: EntryPackStatus = { status: "not_found" };
let passPurchaseOpen = true;
const passStatusReads: [string, Headers][] = [];
mock.module("@/features/passes/backend/entry-pack-status", () => ({
  loadEntryPackStatusPage: (id: string, request: Headers) => {
    passStatusReads.push([id, request]);
    return Promise.resolve(passStatus);
  },
}));
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    isCoworkPassesPageOpenAfterConnection: async () => passPurchaseOpen,
  })
);

mock.module("@/features/withdrawal/components/withdrawal-link", () => ({
  WithdrawalLink: ({ contract }: { contract: { kind: string } }) => (
    <button data-withdrawal-kind={contract.kind} type="button">
      Withdraw from contract
    </button>
  ),
}));

const { CheckoutStatusRoute } = await import("./checkout-status-route");
const { getReservationStatusSignInPath } = signIn;

const orderId = Schema.decodeSync(workspaceReservationIdSchema)(
  "reservation-route"
);

const statusOf = (
  status: CheckoutStatusViewModel["status"]
): CheckoutStatusViewModel =>
  status === "not_found"
    ? { orderId, returnOutcome: "unknown", status }
    : {
        kind: "cowork",
        orderId,
        returnOutcome: "success",
        status,
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
      };

const renderRoute = async ({
  order = orderId,
  presentation,
  searchParams = {},
}: {
  readonly order?: string;
  readonly presentation?: "page" | "modal";
  readonly searchParams?: Record<string, string>;
} = {}) => {
  const errors: unknown[] = [];
  const { prelude } = await prerender(
    await CheckoutStatusRoute({
      params: Promise.resolve({ orderId: order }),
      searchParams: Promise.resolve(searchParams),
      ...(presentation && { presentation }),
    }),
    {
      onError: (error) => {
        errors.push(error);
      },
    }
  );
  return { errors, html: await new Response(prelude).text() };
};

describe("CheckoutStatusRoute", () => {
  afterEach(() => {
    loadCalls.length = 0;
    orderKind = "reservation";
    orderKindReads.length = 0;
    passStatusReads.length = 0;
    passStatus = { status: "not_found" };
    passPurchaseOpen = true;
    passWithdrawal = { status: "none" };
    passWithdrawalReads.length = 0;
    readCookieNames.length = 0;
    connections = 0;
    signedOut = false;
    signedOutReads = 0;
    withdrawalEntry = { status: "none" };
    withdrawalEntryReads.length = 0;
  });

  test("shows a recorded withdrawal and offers withdrawal on a confirmed reservation only", async () => {
    loadResult = Effect.succeed(statusOf("fulfilled"));
    withdrawalEntry = {
      status: "withdrawn",
      refundAmount: { value: 40_000, exponent: 2, currency: "CZK" },
    };
    expect((await renderRoute()).html).toContain('data-withdrawal="withdrawn"');
    expect(withdrawalEntryReads).toEqual([orderId]);

    withdrawalEntry = { status: "offered" };
    expect((await renderRoute()).html).toContain('data-withdrawal="offered"');

    loadResult = Effect.succeed(statusOf("pending"));
    expect((await renderRoute()).html).toContain('data-withdrawal="none"');
  });

  test("loads the order's status with its access cookie and request headers", async () => {
    loadResult = Effect.succeed(statusOf("pending"));

    const { errors, html } = await renderRoute({
      searchParams: { outcome: "success" },
    });

    expect(errors).toEqual([]);
    expect(connections).toBe(1);
    expect(readCookieNames).toEqual([getReservationAccessCookieName(orderId)]);
    expect(loadCalls).toEqual([
      {
        service: statusService,
        authorization: authorizationService,
        input: {
          accessCookie: "access-cookie-value",
          locale: "en-US",
          orderId,
          requestHeaders,
          returnOutcome: "success",
        },
      },
    ]);
    expect(html).toContain('data-payment-window=""');
    expect(html).toContain('data-auto-refresh="true"');
    expect(html).toContain('data-referral-settlement="pending"');
    expect(html).toContain(
      `data-locale="en-US" data-order="${orderId}" data-presentation="page" data-status="pending"`
    );
    expect(signedOutReads).toBe(0);
  });

  test.each([
    ["no outcome", {}],
    ["an unknown outcome", { outcome: "refunded" }],
  ])("treats %s as an unknown return", async (_name, searchParams) => {
    loadResult = Effect.succeed(statusOf("fulfilled"));

    const { html } = await renderRoute({ searchParams });

    expect(loadCalls[0]?.input.returnOutcome).toBe("unknown");
    expect(html).toContain('data-auto-refresh="false"');
  });

  test("passes the modal presentation to the status page", async () => {
    loadResult = Effect.succeed(statusOf("fulfilled"));

    const { html } = await renderRoute({ presentation: "modal" });

    expect(html).toContain('data-presentation="modal"');
  });

  test("connects the reservation invitation Server Action to status", async () => {
    const { errors, html } = await renderRoute();

    expect(errors).toEqual([]);
    expect(html).toContain('data-resend-action="connected"');
  });

  test("connects Team Table additions and refreshes eligibility at the booking end", async () => {
    const endsAt = Temporal.Instant.from("2026-11-18T09:45:00Z");
    loadResult = Effect.succeed({
      kind: "table",
      orderId,
      returnOutcome: "success",
      status: "fulfilled",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      inviteeAdditionEndsAt: endsAt,
    });

    const { errors, html } = await renderRoute();

    expect(errors).toEqual([]);
    expect(html).toContain('data-add-invitees-action="connected"');
    expect(html).toContain(`data-refresh-at="${endsAt.toString()}"`);
    expect(html).toContain('data-auto-refresh="false"');
  });

  test("sends a signed-out visitor of an unknown order to sign in and back", async () => {
    loadResult = Effect.succeed(statusOf("not_found"));
    signedOut = true;

    const { errors, html } = await renderRoute({
      searchParams: { outcome: "cancelled" },
    });

    expect(signedOutReads).toBe(1);
    expect(errors).toHaveLength(1);
    const [redirect] = errors;
    expect(redirect).toBeInstanceOf(RedirectSignal);
    assert(redirect instanceof RedirectSignal, "Expected the redirect signal");
    expect(redirect.location).toBe(
      getReservationStatusSignInPath("en-US", orderId, "cancelled")
    );
    expect(html).not.toContain("data-status=");
  });

  test("shows a signed-in visitor that the order was not found", async () => {
    loadResult = Effect.succeed(statusOf("not_found"));

    const { errors, html } = await renderRoute();

    expect(signedOutReads).toBe(1);
    expect(errors).toEqual([]);
    expect(html).toContain('data-status="not_found"');
  });

  test("serves the reservation status for an order id no order has", async () => {
    orderKind = undefined;
    loadResult = Effect.succeed(statusOf("not_found"));

    const { errors, html } = await renderRoute();

    expect(orderKindReads).toEqual([orderId]);
    expect(loadCalls).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(html).toContain('data-status="not_found"');
  });

  test("renders a pending pass purchase without loading the reservation status", async () => {
    orderKind = "pass-purchase";
    const paymentPage = "https://payment.example.invalid/entry-pack";
    passStatus = { ...passOrder, status: "pending", paymentPage };

    const { errors, html } = await renderRoute({ order: passOrderId });

    expect(errors).toEqual([]);
    expect(passStatusReads).toEqual([[passOrderId, requestHeaders]]);
    expect(loadCalls).toEqual([]);
    expect(withdrawalEntryReads).toEqual([]);
    expect(readCookieNames).toEqual([]);
    expect(html).toContain('data-entry-pack-status="pending"');
    expect(html).toContain('data-auto-refresh="true"');
    expect(html).toContain(`href="${paymentPage}"`);
  });

  test.each([
    { entryCount: 5, canOpenAccess: false },
    { entryCount: null, canOpenAccess: false },
    { entryCount: null, canOpenAccess: true },
  ])(
    "renders a complimentary pass with only its available actions (%p)",
    async ({ entryCount, canOpenAccess }) => {
      orderKind = "pass-purchase";
      passStatus = {
        ...passOrder,
        entryCount,
        status: "granted",
        validFrom: plainDateStringSchema.make("2026-11-19"),
        validUntil: plainDateStringSchema.make("2026-12-19"),
        canOpenAccess,
      };

      const { errors, html } = await renderRoute({ order: passOrderId });

      expect(errors).toEqual([]);
      expect(html).toContain('data-entry-pack-status="granted"');
      expect(html).toContain("Complimentary access granted");
      expect(html).toContain(
        entryCount === null ? "Unlimited membership" : "Entry pack"
      );
      expect(html).toContain('data-auto-refresh="false"');
      expect(html).not.toContain("Paid on");
      expect(html).not.toContain("Continue to payment");
      expect(html).not.toContain("Try again");
      expect(
        html.includes(`href="/en-US/reservation/access/${passOrderId}"`)
      ).toBe(canOpenAccess);
    }
  );

  test.each([
    { entryCount: null, validUntil: "2026-11-19", canOpenAccess: false },
    { entryCount: null, validUntil: "2026-11-25", canOpenAccess: false },
    { entryCount: null, validUntil: "2026-11-25", canOpenAccess: true },
    { entryCount: 5, validUntil: "2026-11-19", canOpenAccess: false },
  ])(
    "renders complimentary cancellation with the effective period and retained access (%p)",
    async ({ entryCount, validUntil, canOpenAccess }) => {
      orderKind = "pass-purchase";
      passStatus = {
        ...passOrder,
        entryCount,
        status: "grant_cancelled",
        validFrom: plainDateStringSchema.make("2026-11-19"),
        validUntil: plainDateStringSchema.make(validUntil),
        canOpenAccess,
      };

      const { errors, html } = await renderRoute({ order: passOrderId });

      expect(errors).toEqual([]);
      expect(html).toContain('data-entry-pack-status="grant_cancelled"');
      expect(html).toContain("Complimentary access cancelled");
      expect(html).not.toContain("Payment was cancelled");
      expect(html).not.toContain("Try again");
      expect(html).toContain('data-auto-refresh="false"');
      if (validUntil === "2026-11-25") {
        expect(html).toMatch(/Nov 19\s*–\s*24, 2026/);
      } else {
        expect(html).not.toContain("Nov 19");
      }
      expect(
        html.includes(`href="/en-US/reservation/access/${passOrderId}"`)
      ).toBe(canOpenAccess);
    }
  );

  test.each([
    ["not_sent", false, m.entryPackStatusGiftInvitationNotSent],
    ["pending", false, m.entryPackStatusGiftInvitationPending],
    ["sent", false, m.entryPackStatusGiftInvitationSent],
    ["sent", true, m.entryPackStatusGiftInvitationSent],
    ["failed", true, m.entryPackStatusGiftInvitationFailed],
  ] as const)(
    "renders the paid gift details for a %s invitation with claimed=%p",
    async (invitation, claimed, invitationMessage) => {
      const locale = "en-US";
      const holderEmail = testEmailAddress("pack-holder");
      const maskedHolderEmail = maskEmailAddress(holderEmail);
      orderKind = "pass-purchase";
      passStatus = {
        ...passOrder,
        status: "paid",
        gift: true,
        invitation,
        claimed,
        maskedHolderEmail,
        paidAt: Temporal.Instant.from("2026-11-19T12:00:00Z"),
        validFrom: plainDateStringSchema.make("2026-11-19"),
        validUntil: plainDateStringSchema.make("2027-01-19"),
      };

      const { errors, html } = await renderRoute({ order: passOrderId });

      expect(errors).toEqual([]);
      expect(html).toContain('data-entry-pack-status="paid"');
      expect(html).toContain("Your Entry pack is paid");
      expect(html).toContain(maskedHolderEmail);
      expect(html).not.toContain(holderEmail);
      expect(html.match(/data-payment-window=/g)).toHaveLength(1);
      expect(html).toContain("Paid on");
      expect(html).toContain('data-auto-refresh="false"');
      expect(html).toContain(`>${invitationMessage({}, { locale })}<`);
      expect(html).toContain(
        `>${claimed ? m.accountPassGiftClaimed({}, { locale }) : m.accountPassGiftNotClaimed({}, { locale })}<`
      );
    }
  );

  test.each([
    "failed",
    "cancelled",
    "expired",
    "refund_required",
    "refunded",
  ] as const)(
    "renders the terminal pass status %s with the appropriate action",
    async (status) => {
      orderKind = "pass-purchase";
      const retryPath = `/en-US/passes/entry-pack?order=${passOrderId}&step=pay`;
      if (status === "refund_required") {
        passStatus = { ...passOrder, status, lateCapture: true };
      } else if (status === "refunded") {
        passStatus = { ...passOrder, status };
      } else {
        passStatus = { ...passOrder, status, retryPath };
      }
      const { errors, html } = await renderRoute({ order: passOrderId });

      expect(errors).toEqual([]);
      expect(html).toContain(`data-entry-pack-status="${status}"`);
      expect(html).toContain('data-auto-refresh="false"');
      expect(html.includes(`href="${retryPath.replace("&", "&amp;")}"`)).toBe(
        status !== "refund_required" && status !== "refunded"
      );
    }
  );

  test("the closed purchase gate shows untouched and failed status without retry controls or guidance", async () => {
    orderKind = "pass-purchase";
    passPurchaseOpen = false;
    passStatus = { ...passOrder, status: "not_started" };
    const draft = await renderRoute({ order: passOrderId });
    expect(draft.errors).toEqual([]);
    expect(draft.html).toContain('data-entry-pack-status="not_started"');
    expect(draft.html).not.toContain("Payment was not completed");
    expect(draft.html).not.toContain("/passes/entry-pack");
    passStatus = {
      ...passOrder,
      status: "failed",
      retryPath: "/en-US/passes/entry-pack",
    };
    const failed = await renderRoute({ order: passOrderId });
    expect(failed.html).not.toContain("fresh secure payment");
    expect(failed.html).not.toContain("/passes/entry-pack");
  });

  test.each([
    [5, "entry-pack"],
    [null, "unlimited-pass"],
  ] as const)(
    "offers withdrawal on the buyer's paid pass status (%s entries)",
    async (entryCount, kind) => {
      orderKind = "pass-purchase";
      passStatus = {
        ...passOrder,
        entryCount,
        status: "paid",
        paidAt: Temporal.Instant.from("2027-01-01T10:00:00Z"),
        validFrom: plainDateStringSchema.make("2027-01-01"),
        validUntil: plainDateStringSchema.make("2027-03-01"),
        gift: false,
      };
      passWithdrawal = { status: "offered" };
      const { errors, html } = await renderRoute({ order: passOrderId });

      expect(errors).toEqual([]);
      expect(html).toContain(`data-withdrawal-kind="${kind}"`);
      expect(passWithdrawalReads).toEqual([
        { kind, id: passOrderId, offer: true },
      ]);
    }
  );

  test("shows a recorded pass withdrawal while purchase continuation is closed", async () => {
    orderKind = "pass-purchase";
    passPurchaseOpen = false;
    passStatus = {
      ...passOrder,
      status: "refund_required",
      lateCapture: false,
    };
    passWithdrawal = {
      status: "withdrawn",
      refundAmount: { value: 25000, exponent: 2, currency: "CZK" },
    };
    const { errors, html } = await renderRoute({ order: passOrderId });

    expect(errors).toEqual([]);
    expect(html).toContain("received your withdrawal");
    expect(html).toContain("250");
    expect(html).not.toContain("data-withdrawal-kind");
    expect(passWithdrawalReads).toEqual([
      { kind: "entry-pack", id: passOrderId, offer: true },
    ]);
  });

  test("the pass status renders the partial refund without a payment action", async () => {
    orderKind = "pass-purchase";
    passStatus = {
      ...passOrder,
      status: "partially_refunded",
      refunded: { value: 25000, exponent: 2, currency: "CZK" },
      refundPending: true,
    };
    const { errors, html } = await renderRoute({ order: passOrderId });
    expect(errors).toEqual([]);
    expect(html).toContain("Part of your payment was refunded.");
    expect(html).toContain("250");
    expect(html).toContain("The rest of your refund is still pending.");
    expect(html).not.toContain("Try again");
    expect(passWithdrawalReads).toEqual([
      { kind: "entry-pack", id: passOrderId, offer: true },
    ]);
  });

  test("preserves the return outcome when a pass purchase requires sign-in", async () => {
    orderKind = "pass-purchase";
    passStatus = { status: "sign_in" };
    const { errors } = await renderRoute({
      order: passOrderId,
      searchParams: { outcome: "success" },
    });

    expect(loadCalls).toEqual([]);
    expect(errors).toHaveLength(1);
    const [redirect] = errors;
    assert(redirect instanceof RedirectSignal, "Expected the redirect signal");
    const location = new URL(
      redirect.location,
      "https://workspace.example.invalid"
    );
    expect(location.pathname).toBe("/en-US/auth/sign-in");
    expect(location.searchParams.get("returnTo")).toBe(
      `/en-US/reservation/status/${passOrderId}?outcome=success`
    );
  });

  test("returns not found for an unavailable pass purchase without reservation fallback", async () => {
    orderKind = "pass-purchase";
    const { errors, html } = await renderRoute({ order: passOrderId });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFoundSignal);
    expect(loadCalls).toEqual([]);
    expect(html).not.toContain("data-entry-pack-status");
    expect(passWithdrawalReads).toEqual([]);
  });

  test("answers an invalid order id with not found before loading", async () => {
    const { errors, html } = await renderRoute({ order: "" });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(NotFoundSignal);
    expect(loadCalls).toEqual([]);
    expect(orderKindReads).toEqual([]);
    expect(html).toContain('data-flow-step="complete"');
    expect(html).toContain('data-skeleton="page"');
  });

  test("shows the bare skeleton while a modal status can't render", async () => {
    const { html } = await renderRoute({ order: "", presentation: "modal" });

    expect(html).toContain('data-skeleton="modal"');
    expect(html).not.toContain("data-flow-step");
  });

  test("fails the render when the status can't load", async () => {
    loadResult = Effect.fail(new Error("Status database unavailable."));
    const logged = [
      spyOn(console, "error"),
      spyOn(console, "log"),
      spyOn(console, "warn"),
    ];

    const { errors, html } = await renderRoute();

    const failureLogs = logged
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .filter((line) => line.includes("Checkout status load failed"));
    for (const spy of logged) spy.mockRestore();
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0]).toContain("level=Error");
    expect(failureLogs[0]).toContain(orderId);
    expect(failureLogs[0]).toContain("operation=checkout.status.load");

    expect(loadCalls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(html).not.toContain("data-status=");
    expect(signedOutReads).toBe(0);
  });
});
