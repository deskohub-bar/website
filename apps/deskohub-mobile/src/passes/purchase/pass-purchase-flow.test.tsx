import { expect, mock, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import {
  BeginCustomerPassPurchase,
  type CustomerPassCatalog,
  type CustomerPassPurchase,
  type CustomerPassPurchasePrice,
  SubmitCustomerPassPurchase,
  UpdateCustomerPassPurchasePrice,
} from "@deskohub/workspace-customer-api";
import { RegistryContext } from "@effect/atom-react";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  act,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
} from "react";
import { PaymentBrowser } from "../../booking/payment-browser.service";
import type { BookingBarAction } from "../../booking/ui/booking-bar";
import { CustomerApi } from "../../customer-api/customer-api.service";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import { nativeCustomerApiTransport } from "../../customer-api/platform-transports";
import {
  makeCustomerDataRegistry,
  settle,
} from "../../customer-api/testing/customer-data-test-registry";
import {
  fakeCustomerDataLayer,
  makeFakeDevice,
} from "../../customer-api/testing/fake-customer-data";
import {
  FakeWorkspace,
  fakeWorkspaceHttpClient,
  fakeWorkspaceOrigin,
} from "../../customer-api/testing/fake-workspace";
import type { AppLocale } from "../../i18n/app-locale";
import { clientRoot } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";

let locale: AppLocale = "en-US";
let routeFocused = true;
const RouteFocus = createContext(true);
const navigate = mock((_href: unknown) => undefined);
const openHosted = mock(
  async (_url: string, _redirect: string) => "dismissed" as const
);

mock.module("expo-router", () => ({
  ...expoRouterStandIn({
    useIsFocused: () => useContext(RouteFocus),
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = useContext(RouteFocus);
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
    useLocalSearchParams: () => ({
      tier: "reserved-desk",
      size: "10",
      startDate: "2026-12-01",
      email: testEmailAddress("ignored"),
    }),
    useRouter: () => ({ replace: navigate, canGoBack: () => false }),
  }),
  Stack: { Screen: () => null },
}));
mock.module("../../i18n/locale-context", () => ({
  useAppLocale: () => locale,
  useProvidedAppLocale: () => locale,
}));
mock.module("../../booking/payment-browser", () => ({
  paymentBrowserLayer: Layer.succeed(PaymentBrowser, {
    open: (url, redirect) => Effect.promise(() => openHosted(url, redirect)),
  }),
  usePaymentBrowserWarmUp: () => undefined,
}));
mock.module("../../booking/ui/booking-bar", () => ({
  BookingBar: ({ action }: { action: BookingBarAction }) => (
    <button
      type="button"
      id="continue"
      onClick={action.onPress}
      disabled={action.disabled || action.busy}
    >
      {action.label}
    </button>
  ),
}));
mock.module("../../ui/async-states", () => ({
  ErrorState: ({ message }: { message: string }) => <output>{message}</output>,
  LoadingState: () => null,
}));
mock.module("../../ui/app-bar", () => ({ AppBar: () => null }));
mock.module("../../booking/ui/booking-steps", () => ({
  BookingSteps: () => null,
}));
mock.module("../../ui/notice", () => ({ Notice: () => null }));
mock.module("../../ui/scroll-screen", () => ({
  ScrollScreen: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module("../../updates/update-offer-card", () => ({
  QuietUpdateOffer: () => null,
}));
mock.module("./choose/pass-choose", () => ({
  PassChoose: ({
    selection,
  }: {
    selection: { tier: string; size: number };
  }) => (
    <output id="choice">
      {selection.tier}/{selection.size}
    </output>
  ),
}));

const actualDetails = { ...(await import("./pass-purchase-details")) };
mock.module("./pass-purchase-details", () => ({
  ...actualDetails,
  PassPurchaseDetails: ({
    details,
    onChange,
  }: Parameters<typeof actualDetails.PassPurchaseDetails>[0]) => (
    <button
      type="button"
      id="gift"
      onClick={() =>
        onChange({
          ...details,
          gift: true,
          holderEmail: details.gift
            ? testEmailAddress("change")
            : testEmailAddress("gift"),
          recipientName: "Synthetic Holder",
          invoice: {
            ...details.invoice,
            billing: "business",
            company: {
              legalName: "Synthetic Company",
              companyId: "01234567",
              vatId: "",
              address: {
                line1: "Example 1",
                city: "Praha",
                postalCode: "18000",
                country: "CZ",
              },
            },
          },
        })
      }
    >
      Gift
    </button>
  ),
}));
const actualReview = { ...(await import("./pass-purchase-review")) };
mock.module("./pass-purchase-review", () => ({
  ...actualReview,
  PassPurchaseReview: ({
    checked,
    onToggle,
    onCode,
    quote,
  }: Parameters<typeof actualReview.PassPurchaseReview>[0]) => (
    <>
      <button
        type="button"
        id="agreement"
        aria-pressed={checked}
        onClick={onToggle}
      >
        {quote.price.fingerprint}
      </button>
      <button type="button" id="apply-code" onClick={() => onCode("DEMO")}>
        Apply code
      </button>
    </>
  ),
}));

const { passCatalogAtom } = await import("../pass-reads");
const { PassPurchaseScreen } = await import("./pass-purchase-screen");
const { render, container } = clientRoot({ keepFetch: true });
const money = (value: number) => ({ value, currency: "CZK", exponent: 2 });
const price = (
  value: number,
  fingerprint: string
): CustomerPassPurchasePrice => ({
  subtotal: money(value),
  total: money(value),
  fingerprint: fingerprint.repeat(64),
  discounts: [],
});
const offeredPack = {
  kind: "entry-pack",
  tier: "reserved-desk",
  size: 10,
} as const;
const catalog: CustomerPassCatalog = {
  entryPacks: [
    {
      product: offeredPack,
      price: money(309000),
      validityMonths: 6,
    },
  ],
  unlimited: [
    {
      product: { kind: "unlimited", tier: "reserved-desk" },
      price: money(309000),
      validityDays: 30,
    },
  ],
  unlimitedCoffeePrice: money(0),
};

const button = async (id: string) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const control = container().querySelector<HTMLButtonElement>(`#${id}`);
    if (control !== null) return control;
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error(`Expected button ${id}`);
};

const press = async (id: string) => {
  const control = await button(id);
  await act(async () => {
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
};

for (const { language, kind } of [
  { language: "en-US", kind: "entry-pack" },
  { language: "cs-CZ", kind: "unlimited" },
] as const) {
  test(`pass purchase repricing and hosted return in ${language}`, async () => {
    locale = language;
    routeFocused = true;
    navigate.mockClear();
    openHosted.mockClear();
    const workspace = FakeWorkspace.forKind("linked");
    const submitCalls: SubmitCustomerPassPurchase[] = [];
    const codeUpdates: UpdateCustomerPassPurchasePrice[] = [];
    const beginCalls: BeginCustomerPassPurchase[] = [];
    const finishBegin = Promise.withResolvers<void>();
    const finishAcceptedBegin = Promise.withResolvers<void>();
    const startDateOrderIds: (string | null)[] = [];
    let catalogAvailable = true;
    let quote: CustomerPassPurchase | undefined;
    const fixture = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(Effect.service(HttpClient.HttpClient), (fallback) =>
        HttpClient.make((request, url) =>
          Effect.gen(function* () {
            if (url.pathname === "/api/customer/passes/catalog") {
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  catalogAvailable
                    ? catalog
                    : { ...catalog, entryPacks: [], unlimited: [] }
                )
              );
            }
            if (url.pathname === "/api/customer/passes/unlimited/start-dates") {
              startDateOrderIds.push(url.searchParams.get("supersedeOrderId"));
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  today: "2026-12-01",
                  lastStartDate: "2026-12-01",
                  starts: {
                    "open-space": [],
                    "reserved-desk": ["2026-12-01"],
                    "reserved-desk-workstation": {
                      "2x27-qhd": [],
                      "2x32-qhd": [],
                      "2x27-4k": [],
                      "2x32-4k": [],
                    },
                  },
                })
              );
            }
            if (url.pathname === "/api/customer/passes/purchases") {
              const web = yield* HttpClientRequest.toWeb(request);
              const body = yield* Effect.promise(() => web.json());
              const payload = yield* Schema.decodeUnknownEffect(
                BeginCustomerPassPurchase
              )(body);
              expect(payload.product).toEqual(
                kind === "entry-pack"
                  ? offeredPack
                  : {
                      kind,
                      selection: {
                        tier: "reserved-desk",
                        startDate: "2026-12-01",
                      },
                    }
              );
              expect(payload.locale).toBe(language);
              expect(body).toMatchObject({
                expectedBuyerAccountId: workspace.data.accountId,
              });
              expect(payload.holderEmail).toBe(testEmailAddress("gift"));
              beginCalls.push(payload);
              quote = {
                orderId: payload.orderId,
                product: payload.product,
                payPath: "/pay",
                statusPath: "/status",
                validFrom: "2026-12-01",
                lastUsableDate: "2027-05-31",
                price: price(309000, "a"),
                disclosure: {
                  documents: [
                    {
                      key: "terms-and-conditions",
                      hash: "terms",
                      path: "/terms",
                      hashAlgorithm: "sha256",
                    },
                    {
                      key: "operating-rules",
                      hash: "rules",
                      path: "/rules",
                      hashAlgorithm: "sha256",
                    },
                  ],
                },
              };
              if (beginCalls.length === 1) {
                yield* Effect.promise(() => finishBegin.promise);
                return HttpClientResponse.fromWeb(request, Response.json({}));
              }
              if (kind === "unlimited" && beginCalls.length === 2) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    {
                      _tag: "CustomerPassPurchaseRefused",
                      reason: "holds-unavailable",
                      blockingDates: ["2026-12-01"],
                    },
                    { status: 409 }
                  )
                );
              }
              if (kind === "unlimited" && beginCalls.length === 3) {
                yield* Effect.promise(() => finishAcceptedBegin.promise);
              }
              return HttpClientResponse.fromWeb(request, Response.json(quote));
            }
            if (
              url.pathname ===
              `/api/customer/passes/purchases/${quote?.orderId}/price`
            ) {
              expect(request.method).toBe("PATCH");
              const web = yield* HttpClientRequest.toWeb(request);
              const body = yield* Effect.promise(() => web.json());
              const update = yield* Schema.decodeUnknownEffect(
                UpdateCustomerPassPurchasePrice
              )(body);
              codeUpdates.push(update);
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  status: "ready",
                  price: {
                    ...price(300000, "c"),
                    appliedDiscountCode: update.submittedCode,
                  },
                })
              );
            }
            if (
              url.pathname ===
              `/api/customer/passes/purchases/${quote?.orderId}/payment`
            ) {
              const web = yield* HttpClientRequest.toWeb(request);
              const body = yield* Effect.promise(() => web.json());
              submitCalls.push(
                yield* Schema.decodeUnknownEffect(SubmitCustomerPassPurchase)(
                  body
                )
              );
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  [
                    { status: "pricing_changed", price: price(310000, "b") },
                    {
                      status: "terms_changed",
                      disclosure: {
                        documents: quote?.disclosure.documents.map(
                          (document) => ({
                            ...document,
                            hash: `updated-${document.hash}`,
                          })
                        ),
                      },
                    },
                  ][submitCalls.length - 1] ?? {
                    status: "hosted",
                    redirectUrl: "https://example.test/fake-payment",
                    statusUrl: "/status",
                  }
                )
              );
            }
            return yield* fallback.execute(request);
          }).pipe(Effect.orDie)
        )
      )
    ).pipe(Layer.provide(fakeWorkspaceHttpClient(workspace)));
    const customerApi = CustomerApi.Default.pipe(
      Layer.provide(
        nativeCustomerApiTransport({
          apiOrigin: fakeWorkspaceOrigin,
          readSessionCookie: Effect.succeed("deskohub.session_token=sample"),
        })
      ),
      Layer.provide(fixture)
    );
    const registry = makeCustomerDataRegistry(
      Layer.effectContext(
        Effect.gen(function* () {
          const base = yield* Layer.build(
            fakeCustomerDataLayer({ workspace, device: makeFakeDevice() })
          );
          const fixtureApi = yield* Layer.build(customerApi);
          return Context.add(
            base,
            CustomerApi,
            Context.get(fixtureApi, CustomerApi)
          );
        })
      )
    );
    expect(await settle(registry, accountAtom)).toMatchObject({
      _tag: "Success",
    });
    expect(await settle(registry, passCatalogAtom)).toMatchObject({
      _tag: "Success",
    });
    const renderCheckout = () =>
      render(
        <RegistryContext.Provider value={registry}>
          <RouteFocus.Provider value={routeFocused}>
            <PassPurchaseScreen key={language} kind={kind} />
          </RouteFocus.Provider>
        </RegistryContext.Provider>
      );
    await renderCheckout();
    await button("continue");
    expect(container().querySelector("#choice")?.textContent).toBe(
      "reserved-desk/10"
    );
    await press("continue");
    await press("gift");
    await press("continue");
    expect(beginCalls).toHaveLength(1);

    routeFocused = false;
    await renderCheckout();
    await act(async () => {
      finishBegin.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    routeFocused = true;
    await renderCheckout();
    expect((await button("continue")).disabled).toBe(false);
    await press("gift");

    workspace.signedIn = false;
    await press("continue");
    expect(beginCalls).toHaveLength(1);
    workspace.signedIn = true;

    catalogAvailable = false;
    await act(async () => {
      registry.refresh(passCatalogAtom);
      expect(await settle(registry, passCatalogAtom)).toMatchObject({
        _tag: "Success",
        success: { entryPacks: [] },
      });
    });
    await press("continue");
    expect(beginCalls).toHaveLength(2);
    expect(beginCalls[0]).toEqual(beginCalls[1]);

    if (kind === "unlimited") {
      expect(container().querySelector("#choice")).not.toBeNull();
      catalogAvailable = true;
      await act(async () => {
        registry.refresh(passCatalogAtom);
        await settle(registry, passCatalogAtom);
      });
      await press("continue");
      await press("continue");
      expect(beginCalls).toHaveLength(3);
      expect(beginCalls[2]?.orderId).not.toBe(beginCalls[1]?.orderId);
      const accepted = beginCalls[2];
      if (!accepted) throw new Error("Expected the replacement purchase");

      routeFocused = false;
      await renderCheckout();
      await act(async () => {
        finishAcceptedBegin.resolve();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect((await button("continue")).disabled).toBe(false);
      expect(startDateOrderIds).not.toContain(accepted.orderId);

      routeFocused = true;
      await renderCheckout();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(startDateOrderIds).toContain(accepted.orderId);
      await press("continue");
      expect(beginCalls).toHaveLength(4);
      expect(beginCalls[3]).toEqual(accepted);
    }

    expect((await button("continue")).disabled).toBe(true);
    await press("agreement");
    await press("apply-code");
    expect(codeUpdates).toEqual([
      {
        productKind: kind,
        displayedPriceFingerprint: "a".repeat(64),
        submittedCode: "DEMO",
      },
    ]);
    expect((await button("continue")).disabled).toBe(true);
    await press("agreement");
    await press("continue");
    expect((await button("agreement")).getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect((await button("continue")).disabled).toBe(true);
    expect(openHosted).toHaveBeenCalledTimes(0);

    await press("agreement");
    await press("continue");
    expect((await button("agreement")).getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect((await button("continue")).disabled).toBe(true);
    expect(openHosted).toHaveBeenCalledTimes(0);

    await press("agreement");
    await press("continue");
    expect(
      submitCalls.map(
        ({ displayedPriceFingerprint }) => displayedPriceFingerprint
      )
    ).toEqual(["c".repeat(64), "b".repeat(64), "b".repeat(64)]);
    expect(submitCalls[2]).toMatchObject({
      accepted: true,
      acceptedDocuments: [
        { key: "terms-and-conditions", hash: "updated-terms" },
        { key: "operating-rules", hash: "updated-rules" },
      ],
      billing: {
        purpose: "business",
        invoice: "required",
        buyer: { legalName: "Synthetic Company", companyId: "01234567" },
      },
      returnTarget: "native-app",
    });
    const orderId = quote?.orderId;
    expect(openHosted).toHaveBeenCalledWith(
      "https://example.test/fake-payment",
      `deskohub://passes/purchases/${orderId}?after=payment`
    );
    expect(navigate).toHaveBeenCalledWith({
      pathname: "/passes/purchases/[orderId]",
      params: { orderId, after: "payment" },
    });
    await render(null);
    registry.dispose();
  });
}
