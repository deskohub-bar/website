import { expect, mock, spyOn, test } from "bun:test";
import type {
  CustomerPassPurchaseRefused,
  CustomerPassPurchaseStatus,
} from "@deskohub/workspace-customer-api";
import { RegistryContext } from "@effect/atom-react";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { act, createElement, useEffect } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import {
  CustomerApi,
  CustomerAuthApi,
} from "../../../customer-api/customer-api.service";
import { nativeCustomerApiTransport } from "../../../customer-api/platform-transports";
import { makeCustomerDataRegistry } from "../../../customer-api/testing/customer-data-test-registry";
import {
  fakeCustomerDataLayer,
  makeFakeDevice,
} from "../../../customer-api/testing/fake-customer-data";
import {
  FakeWorkspace,
  fakeWorkspaceOrigin,
} from "../../../customer-api/testing/fake-workspace";
import { m } from "../../../i18n/messages";
import { clientRoot } from "../../../testing/client-root";
import { expoRouterStandIn } from "../../../testing/expo-router-stand-in";
import type { PassPurchaseStatusCheck } from "./pass-purchase-status-state";

mock.module("expo-router", () =>
  expoRouterStandIn({
    useFocusEffect: (callback) => useEffect(callback, [callback]),
  })
);
const openSitePage = mock(async (_url: string) => ({
  type: "opened" as const,
}));
mock.module("../../../routing/open-site-page", () => ({
  appBrowserTabColors: {},
  openSitePage,
}));
mock.module("../../../auth/auth-client", () => ({
  apiOrigin: fakeWorkspaceOrigin,
}));
const {
  availablePassPurchaseContinuation,
  confirmedRetryPayload,
  passPurchaseResumeUrl,
  usePassPurchasePayment,
} = await import("./use-pass-purchase-payment");

const root = clientRoot({ keepFetch: true });
const amount = { value: 45_000, currency: "CZK", exponent: 2 } as const;
const approved = {
  priorPaymentAttemptId: "previous-attempt",
  price: {
    fingerprint: "a".repeat(64),
    subtotal: amount,
    total: amount,
    discounts: [],
  },
  disclosure: {
    documents: [
      {
        key: "terms-and-conditions",
        path: "/cs-CZ/podminky",
        hash: "terms-revision",
        hashAlgorithm: "sha256",
      },
      {
        key: "operating-rules",
        path: "/cs-CZ/provozni-rad",
        hash: "rules-revision",
        hashAlgorithm: "sha256",
      },
    ],
    earlyStartRequest: "Synthetic early start disclosure",
  },
} satisfies NonNullable<CustomerPassPurchaseStatus["retry"]>;

const status = {
  orderId: "836223a1-29fd-4c4f-b876-49782ae18eda",
  status: "cancelled",
  productKind: "unlimited",
  tier: "open-space",
  statusPath: "/cs-CZ/status",
  retry: approved,
} satisfies CustomerPassPurchaseStatus;

test("retries the confirmed attempt with the reviewed price and legal evidence", () => {
  expect(confirmedRetryPayload(status, approved, "native-app")).toEqual({
    productKind: "unlimited",
    priorPaymentAttemptId: approved.priorPaymentAttemptId,
    displayedPriceFingerprint: approved.price.fingerprint,
    accepted: true,
    acceptedDocuments: [
      { key: "terms-and-conditions", hash: "terms-revision" },
      { key: "operating-rules", hash: "rules-revision" },
    ],
    unlimitedEarlyStartAccepted: true,
    returnTarget: "native-app",
  });
  expect(
    confirmedRetryPayload(
      { ...status, productKind: "entry-pack" },
      approved,
      "web-app"
    )
  ).not.toHaveProperty("unlimitedEarlyStartAccepted");
});

test("requires the exact prior attempt, quote, and disclosure to remain eligible", () => {
  const changed = [
    { ...status, status: "checking" },
    { ...status, status: "paid" },
    { ...status, retry: { ...approved, priorPaymentAttemptId: "new-attempt" } },
    {
      ...status,
      retry: {
        ...approved,
        price: { ...approved.price, fingerprint: "b".repeat(64) },
      },
    },
    {
      ...status,
      retry: {
        ...approved,
        disclosure: {
          ...approved.disclosure,
          earlyStartRequest: "Changed disclosure",
        },
      },
    },
  ] satisfies CustomerPassPurchaseStatus[];
  for (const purchase of changed) {
    expect(
      confirmedRetryPayload(purchase, approved, "native-app")
    ).toBeUndefined();
  }
});

test("offers only the continuation supported by the current status", () => {
  const resumePath = "/cs-CZ/passes/unlimited?step=pay";
  const paymentUrl = "https://payment.test/hosted";
  expect(
    availablePassPurchaseContinuation({
      ...status,
      status: "not_started",
      resumePath,
    })
  ).toEqual({ kind: "resume", path: resumePath });
  expect(
    availablePassPurchaseContinuation({
      ...status,
      status: "pending",
      paymentUrl,
    })
  ).toEqual({ kind: "reopen", url: paymentUrl });
  expect(
    availablePassPurchaseContinuation({
      ...status,
      status: "paid",
      paymentUrl,
      resumePath,
    })
  ).toBeUndefined();
});

test("resumes Pay only at an owned relative workspace path", () => {
  const origin = "https://workspace.deskohub.test";
  expect(passPurchaseResumeUrl("/passes/pay", origin)).toBe(
    `${origin}/passes/pay`
  );
  expect(passPurchaseResumeUrl("//other.test/pay", origin)).toBeUndefined();
  expect(
    passPurchaseResumeUrl("https://other.test/pay", origin)
  ).toBeUndefined();
});

const draft = {
  ...status,
  status: "not_started",
  resumePath: "/cs-CZ/passes/pay",
} as const;

function setupAction(
  purchase: CustomerPassPurchaseStatus,
  {
    pauseAt,
    failure,
  }: {
    readonly pauseAt?: "session" | "dispatch";
    readonly failure?: CustomerPassPurchaseRefused["reason"] | "unconfirmed";
  } = {}
) {
  const actionPaused = Promise.withResolvers<void>();
  const releaseAction = Promise.withResolvers<void>();
  const pause = Effect.promise(() => {
    actionPaused.resolve();
    return releaseAction.promise;
  });
  let cookieReads = 0;
  const workspace = FakeWorkspace.forKind("linked");
  const { accountId, account } = workspace.data;
  const checks: PassPurchaseStatusCheck[] = [];
  const posts: string[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const answer = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      if (url.pathname === "/api/auth/get-session") {
        if (pauseAt === "session") yield* pause;
        return answer({
          session: {
            id: "sample-session",
            userId: accountId,
            expiresAt: "2030-01-01T00:00:00Z",
          },
          user: {
            id: accountId,
            email: account.email,
            emailVerified: true,
            name: "",
            locale: account.locale,
          },
        });
      }
      if (request.method === "POST") {
        posts.push(url.pathname);
        if (failure === "unconfirmed") return answer({}, 502);
        return failure
          ? answer(
              {
                _tag: "CustomerPassPurchaseRefused",
                reason: failure,
              },
              409
            )
          : answer({ status: "pending", statusUrl: purchase.statusPath });
      }
      return answer(purchase);
    })
  );
  const registry = makeCustomerDataRegistry(
    Layer.mergeAll(
      fakeCustomerDataLayer({ workspace, device: makeFakeDevice() }),
      Layer.fresh(
        Layer.merge(CustomerApi.Default, CustomerAuthApi.Default)
      ).pipe(
        Layer.provide(
          nativeCustomerApiTransport({
            apiOrigin: fakeWorkspaceOrigin,
            readSessionCookie: Effect.gen(function* () {
              cookieReads += 1;
              // The order read and account check each look up the cookie
              // before the third lookup prepares the outgoing payment POST.
              if (pauseAt === "dispatch" && cookieReads === 3) yield* pause;
              return "deskohub.session_token=sample";
            }),
          })
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
      )
    )
  );
  let payment: ReturnType<typeof usePassPurchasePayment> | undefined;
  function Screen() {
    payment = usePassPurchasePayment(purchase.orderId, "en-US", (kind) => {
      checks.push(kind);
    });
    return null;
  }
  return {
    actionPaused: actionPaused.promise,
    releaseAction: releaseAction.resolve,
    checks,
    posts,
    payment: () => {
      if (!payment) throw new Error("The screen has not mounted.");
      return payment;
    },
    mount: () =>
      root.render(
        createElement(
          RegistryContext.Provider,
          { value: registry },
          createElement(Screen)
        )
      ),
    dispose: async () => {
      releaseAction.resolve();
      await root.render(null);
      registry.dispose();
    },
  };
}

test.each(["session", "dispatch"] as const)(
  "abandoning Retry during %s preparation sends no payment write",
  async (pauseAt) => {
    const action = setupAction(status, { pauseAt });
    let ready: Promise<void> | undefined;
    try {
      await action.mount();
      await act(async () => {
        ready = action.payment().retry(approved);
        await action.actionPaused;
      });
      action.payment().abandon();
      await act(async () => {
        action.releaseAction();
        await ready;
      });
      expect(action.posts).toEqual([]);
      expect(action.checks).toEqual([]);
    } finally {
      await action.dispose();
    }
  }
);

test("abandoning draft resume during account verification opens no browser", async () => {
  openSitePage.mockClear();
  const action = setupAction(draft, { pauseAt: "session" });
  try {
    await action.mount();
    let ready: Promise<void> | undefined;
    await act(async () => {
      ready = action.payment().continuePayment("resume");
      await action.actionPaused;
    });
    await root.render(null);
    action.releaseAction();
    await ready;
    expect(openSitePage).not.toHaveBeenCalled();
    expect(action.checks).toEqual([]);
  } finally {
    await action.dispose();
  }
});

test("the PWA resumes the confirmed draft in the current tab", async () => {
  openSitePage.mockClear();
  const action = setupAction(draft);
  const oldPlatform = Platform.OS;
  Object.defineProperty(Platform, "OS", { value: "web" });
  const assign = spyOn(globalThis.location, "assign").mockImplementation(
    () => {}
  );
  try {
    await action.mount();
    await act(async () => action.payment().continuePayment("resume"));
    expect(assign).toHaveBeenCalledWith(
      `${fakeWorkspaceOrigin}${draft.resumePath}`
    );
    expect(openSitePage).not.toHaveBeenCalled();
    expect(action.checks).toEqual([]);
  } finally {
    assign.mockRestore();
    Object.defineProperty(Platform, "OS", { value: oldPlatform });
    await action.dispose();
  }
});

test("Android draft launch only checks status after the app returns", async () => {
  const action = setupAction(draft);
  let onChange: ((state: AppStateStatus) => void) | undefined;
  const remove = mock(() => {
    onChange = undefined;
  });
  const listen = spyOn(AppState, "addEventListener").mockImplementation(
    (type, listener) => {
      if (type === "change") {
        onChange = listener as (state: AppStateStatus) => void;
      }
      return { remove };
    }
  );
  try {
    await action.mount();
    await act(async () => action.payment().continuePayment("resume"));
    expect(listen).toHaveBeenCalledTimes(1);
    onChange?.("active");
    expect(action.checks).toEqual([]);
    onChange?.("background");
    onChange?.("active");
    onChange?.("background");
    onChange?.("active");
    expect(action.checks).toEqual(["after-payment"]);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    listen.mockRestore();
    await action.dispose();
  }
});

test.each([
  ["payment-in-progress", m.reservations_payment_retry_settling],
  ["quote-expired", m.pass_purchase_status_quote_expired],
  ["holds-unavailable", m.pass_purchase_status_hold_unavailable],
] as const)(
  "the %s refusal explains why and checks status without settlement polling",
  async (failure, message) => {
    const action = setupAction(status, { failure });
    try {
      await action.mount();
      await act(async () => action.payment().retry(approved));
      expect(action.posts).toHaveLength(1);
      expect(action.payment().notice).toBe(message({}, { locale: "en-US" }));
      expect(action.checks).toEqual(["manual"]);
    } finally {
      await action.dispose();
    }
  }
);

test("an uncertain dispatched payment starts settlement reconciliation", async () => {
  const action = setupAction(status, { failure: "unconfirmed" });
  try {
    await action.mount();
    await act(async () => action.payment().retry(approved));
    expect(action.posts).toHaveLength(1);
    expect(action.checks).toEqual(["unconfirmed"]);
  } finally {
    await action.dispose();
  }
});
