import { expect, mock, spyOn, test } from "bun:test";
import {
  CustomerReservationOrderId,
  type CustomerReservationSummary,
} from "@deskohub/workspace-customer-api";
import { RegistryContext } from "@effect/atom-react";
import { Effect, Layer, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { AtomRegistry } from "effect/reactivity";
import type { ReactElement } from "react";
import { apiOrigin } from "../../auth/auth-client";
import { CustomerApi } from "../../customer-api/customer-api.service";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import { nativeCustomerApiTransport } from "../../customer-api/platform-transports";
import {
  makeCustomerDataRegistry,
  makeFakeCustomerData,
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
import { sampleLaterMeetingRoom } from "../../customer-api/testing/sample-fixtures";
import { withSampleHistory } from "../../customer-api/testing/sample-history";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { heldPassesAtom, passCatalogAtom } from "../../passes/pass-reads";
import { sitePageUrl } from "../../routing/site-page";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { findAll, hostTree, textOf } from "../../ui/testing/element-tree";
import { invitedReservationsAtom } from "./invited-reservations";
import { reservationHistoryAtom } from "./reservations-list-state";
import {
  pastVisitsApiLayer,
  samplePastVisits,
} from "./testing/past-visits-sample";

mock.module("expo-router", () => expoRouterStandIn());

const openedPages: Array<string> = [];
// How many next pages the browser blocks.
let blockedPages = 0;
mock.module("../../routing/open-site-page", () => ({
  appBrowserTabColors: {},
  openSitePage: async (url: string) => {
    if (blockedPages > 0) {
      blockedPages -= 1;
      throw new Error("blocked");
    }
    openedPages.push(url);
    return { type: "opened" };
  },
}));

const { ReservationsListScreen } = await import("./reservations-list-screen");
const toasts = await import("../../ui/toast");
const { ToastProvider } = toasts;

const screenHosts = (registry: AtomRegistry.AtomRegistry) => {
  const within = (node: ReactElement) => (
    <RegistryContext.Provider value={registry}>
      <AppLocaleProvider locale="en-US">
        <ToastProvider>{node}</ToastProvider>
      </AppLocaleProvider>
    </RegistryContext.Provider>
  );
  const { error } = console;
  const warnings = spyOn(console, "error").mockImplementation((...args) => {
    if (!/incorrect casing|does not recognize the/.test(String(args[0])))
      error(...args);
  });
  try {
    return hostTree(<ReservationsListScreen />, within);
  } finally {
    warnings.mockRestore();
  }
};

const screenText = (registry: AtomRegistry.AtomRegistry) =>
  findAll(screenHosts(registry), "Text").map(textOf).join("\n");

test.each(["completion-required", "linked"] as const)(
  "lists invitations independently of own history for a %s account",
  async (kind) => {
    const sample = FakeWorkspace.forKind(kind).data;
    const invitation = sample.invited?.current[0];
    if (!invitation?.bookedBy.name) throw new Error("Expected a sample invite");
    const workspace = new FakeWorkspace(sample);
    if (kind === "linked") withSampleHistory(workspace, "cancelled-invitation");
    workspace.fail("listReservations", "service-unavailable");
    const { registry } = makeFakeCustomerData(kind, workspace);

    const releaseAccount = registry.mount(accountAtom);
    const releaseInvitations = registry.mount(invitedReservationsAtom);
    const releaseHistory =
      kind === "linked" ? registry.mount(reservationHistoryAtom) : undefined;
    try {
      await settle(registry, accountAtom);
      expect(
        Result.isSuccess(await settle(registry, invitedReservationsAtom))
      ).toBe(true);
      if (kind === "linked") {
        expect(
          Result.isFailure(await settle(registry, reservationHistoryAtom))
        ).toBe(true);
      } else {
        expect(workspace.calls).not.toContain("listReservations");
      }
      const text = screenText(registry);
      expect(text).toContain(invitation.bookedBy.name);
      const cancelled = m.reservationStatusCancelled({}, { locale: "en-US" });
      if (kind === "linked") {
        expect(text).toContain(cancelled);
      } else {
        expect(text).not.toContain(cancelled);
      }
    } finally {
      releaseAccount();
      releaseInvitations();
      releaseHistory?.();
      registry.dispose();
    }
  }
);

test("empty history shows a pass catalog outage and retry restores the Unlimited period", async () => {
  const workspace = FakeWorkspace.forKind("linked");
  const base = fakeCustomerDataLayer({ workspace, device: makeFakeDevice() });
  const locale = "en-US" as const;
  let catalogAvailable = false;
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(Effect.service(HttpClient.HttpClient), (fallback) =>
      HttpClient.make((request, url) => {
        const respond = (body: unknown, status = 200) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json(body, { status }))
          );
        switch (url.pathname.replace(/\/$/, "")) {
          case "/api/customer/reservations":
            return respond({ current: [], past: [], unavailable: [] });
          case "/api/customer/passes/catalog":
            return catalogAvailable
              ? respond({
                  entryPacks: [],
                  unlimited: [],
                  unlimitedCoffeePrice: {
                    currency: "CZK",
                    value: 0,
                    exponent: 2,
                  },
                })
              : respond({ _tag: "CustomerServiceUnavailable" }, 503);
          case "/api/customer/passes":
            return respond({
              held: [
                {
                  kind: "unlimited",
                  status: "active",
                  tier: "reserved-desk",
                  passId: "dd7dea68-2624-4ed3-acf5-7d3f2d4a8427",
                  validFrom: "2026-11-08",
                  lastUsableDate: "2026-12-07",
                  today: { date: "2026-11-22", day: 15, totalDays: 30 },
                },
              ],
              boughtForOthers: [],
            });
          default:
            return fallback.execute(request);
        }
      })
    )
  ).pipe(Layer.provide(fakeWorkspaceHttpClient(workspace)));
  const api = Layer.fresh(CustomerApi.Default).pipe(
    Layer.provide(
      nativeCustomerApiTransport({
        apiOrigin: fakeWorkspaceOrigin,
        readSessionCookie: Effect.succeed(""),
      })
    ),
    Layer.provide(transport)
  );
  const registry = makeCustomerDataRegistry(Layer.mergeAll(base, api));
  const release = [
    registry.mount(accountAtom),
    registry.mount(reservationHistoryAtom),
    registry.mount(passCatalogAtom),
    registry.mount(heldPassesAtom(locale)),
  ];
  try {
    await settle(registry, accountAtom);
    await settle(registry, reservationHistoryAtom);
    await settle(registry, passCatalogAtom);
    const outage = screenText(registry);
    expect(outage).toContain(m.passes_load_failed({}, { locale }));
    expect(outage).toContain(m.account_retry({}, { locale }));
    expect(outage).not.toContain(m.reservations_none_yet({}, { locale }));

    catalogAvailable = true;
    registry.refresh(passCatalogAtom);
    await settle(registry, passCatalogAtom);
    await settle(registry, heldPassesAtom(locale));
    const recovered = screenText(registry);
    expect(recovered).toContain(m.passes_door_code({}, { locale }));
    expect(recovered).not.toContain(m.passes_load_failed({}, { locale }));
  } finally {
    for (const dispose of release) dispose();
    registry.dispose();
  }
});

/**
 * The linked account's screen over three past coworking visits paid with
 * money, except as `settled` names (undefined: no settlement), with the pass
 * rollout open and no pass held.
 */
const withPastVisits = async (
  settled: Readonly<Record<string, string | undefined>>,
  check: (hosts: ReturnType<typeof hostTree>) => void,
  current: ReadonlyArray<CustomerReservationSummary> = []
) => {
  const workspace = FakeWorkspace.forKind("linked");
  const base = fakeCustomerDataLayer({ workspace, device: makeFakeDevice() });
  const locale = "en-US" as const;
  const past = samplePastVisits(3).map(({ settlement, ...visit }) => {
    const value = Object.hasOwn(settled, visit.orderId)
      ? settled[visit.orderId]
      : settlement;
    return value === undefined ? visit : { ...visit, settlement: value };
  });
  const api = pastVisitsApiLayer({ workspace, past, current });
  const registry = makeCustomerDataRegistry(Layer.mergeAll(base, api));
  const release = [
    registry.mount(accountAtom),
    registry.mount(reservationHistoryAtom),
    registry.mount(passCatalogAtom),
    registry.mount(heldPassesAtom(locale)),
  ];
  try {
    await settle(registry, accountAtom);
    await settle(registry, reservationHistoryAtom);
    await settle(registry, passCatalogAtom);
    await settle(registry, heldPassesAtom(locale));
    check(screenHosts(registry));
  } finally {
    for (const dispose of release) dispose();
    registry.dispose();
  }
};

const savingsLinks = (hosts: ReturnType<typeof hostTree>) =>
  findAll(hosts, "Pressable").filter(
    (pressable) =>
      pressable.props["aria-label"] ===
      m.reservations_save_with_passes({}, { locale: "en-US" })
  );

test("the Past group ends with the savings link, after Show all", async () => {
  await withPastVisits({ "sample-visit-1": "entry-pack" }, (hosts) => {
    const [link] = savingsLinks(hosts);
    expect(savingsLinks(hosts)).toHaveLength(1);
    // Past's rows, then its Show all action, then the link, in one group.
    const texts = findAll(hosts, "Text").map(textOf);
    const showAll = texts.indexOf(
      m.reservations_show_all_past({}, { locale: "en-US" })
    );
    const savings = texts.indexOf(
      m.reservations_save_with_passes({}, { locale: "en-US" })
    );
    expect(showAll).toBeGreaterThan(
      texts.indexOf(m.reservations_section_past({}, { locale: "en-US" }))
    );
    expect(savings).toBe(showAll + 1);
    expect(link?.props.role).toBe("link");
  });
});

test("the savings link opens Pricing in the app's language, unselected", async () => {
  await withPastVisits({}, (hosts) => {
    openedPages.length = 0;
    const press = savingsLinks(hosts)[0]?.props.onPress as () => void;
    press();
    expect(openedPages).toEqual([sitePageUrl("/pricing", apiOrigin, "en-US")]);
    expect(new URL(openedPages[0] ?? "").search).toBe("");

    // Enter follows it too, on the web, where the link has no href.
    openedPages.length = 0;
    const keyDown = savingsLinks(hosts)[0]?.props.onKeyDown as (event: {
      nativeEvent: { key: string };
      preventDefault: () => void;
    }) => void;
    keyDown({ nativeEvent: { key: "Enter" }, preventDefault: () => undefined });
    expect(openedPages).toHaveLength(1);
  });
});

test("visits paid with an Entry pack offer no savings link, and carry its label", async () => {
  await withPastVisits(
    {
      "sample-visit-1": "entry-pack",
      "sample-visit-2": "entry-pack",
      "sample-visit-3": "entry-pack",
    },
    (hosts) => {
      expect(savingsLinks(hosts)).toHaveLength(0);
      expect(
        findAll(hosts, "Text")
          .map(textOf)
          .filter(
            (text) => text === m.passes_paid_with_pack({}, { locale: "en-US" })
          ).length
      ).toBeGreaterThan(0);
    }
  );
});

test("free, unsettled and unknown settlements offer no savings link", async () => {
  await withPastVisits(
    {
      "sample-visit-1": "free",
      // A refunded order, or a value a later server adds.
      "sample-visit-2": undefined,
      "sample-visit-3": "voucher",
    },
    (hosts) => {
      expect(savingsLinks(hosts)).toHaveLength(0);
    }
  );
});

test("an upcoming Entry pack visit keeps the withdrawal the server offers", async () => {
  const room = sampleLaterMeetingRoom(new Date());
  const current = [
    { ...room, settlement: "entry-pack" },
    {
      ...room,
      id: "sample-reservation-room-later-2",
      orderId: CustomerReservationOrderId.make("sample-room-later-2"),
      settlement: "entry-pack",
    },
  ];
  await withPastVisits(
    {},
    (hosts) => {
      const texts = findAll(hosts, "Text").map(textOf);
      // The next visit's ticket and the later visit's row each carry both.
      expect(
        texts.filter(
          (text) => text === m.passes_paid_with_pack({}, { locale: "en-US" })
        )
      ).toHaveLength(2);
      expect(
        texts.filter(
          (text) =>
            text === m.reservationWithdrawalAction({}, { locale: "en-US" })
        )
      ).toHaveLength(2);
    },
    current
  );
});

test("a blocked Pricing page shows the neutral toast", async () => {
  const shown: Array<{ readonly tone?: string }> = [];
  const useToast = spyOn(toasts, "useToast").mockReturnValue({
    show: (toast) => {
      shown.push(toast);
    },
  });
  try {
    blockedPages = 1;
    await withPastVisits({}, (hosts) => {
      const press = savingsLinks(hosts)[0]?.props.onPress as () => void;
      press();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.tone).toBe("neutral");
  } finally {
    blockedPages = 0;
    useToast.mockRestore();
  }
});
