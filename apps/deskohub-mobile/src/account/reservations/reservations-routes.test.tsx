import { expect, mock, spyOn, test } from "bun:test";
import { CustomerReservationOrderId } from "@deskohub/workspace-customer-api";
import { RegistryContext } from "@effect/atom-react";
import type { NativeStackNavigationOptions } from "expo-router";
import {
  type AriaAttributes,
  act,
  createElement,
  type ReactElement,
  useEffect,
} from "react";
import type { PressableProps, ViewProps } from "react-native";
import * as ReactNative from "react-native";
import {
  orderStatusHref,
  reservationsHref,
} from "../../booking/booking-routes";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import {
  makeFakeCustomerData,
  settle,
} from "../../customer-api/testing/customer-data-test-registry";
import { FakeWorkspace } from "../../customer-api/testing/fake-workspace";
import { withSampleHistory } from "../../customer-api/testing/sample-history";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { clientRoot } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestWindowDimensions } from "../../testing/window-dimensions";
import { elementTree, find } from "../../ui/testing/element-tree";
import { orderStatusAtoms } from "./order-status-state";
import { reservationHistoryAtom } from "./reservations-list-state";

let params: { orderId: string; after?: string } = { orderId: "" };
let screenOptions: NativeStackNavigationOptions | undefined;
let activeRoute: ReactElement | undefined;
let runFocusEffects = false;
const router = {
  push: mock((_href: unknown) => {}),
  replace: mock((_href: unknown) => {}),
  dismissTo: mock((_href: unknown) => {}),
  back: mock(() => {}),
  canGoBack: () => true,
};

mock.module("expo-router", () => ({
  ...expoRouterStandIn({
    useFocusEffect: (effect: () => undefined | (() => void)) =>
      useEffect(() => (runFocusEffects ? effect() : undefined), [effect]),
    useLocalSearchParams: () => params,
    useRouter: () => router,
  }),
  Stack: Object.assign(() => activeRoute, {
    Screen: ({ options }: { options: NativeStackNavigationOptions }) => {
      screenOptions = options;
      return null;
    },
  }),
}));

// React DOM needs plain styles where native View permits falsy values and
// Pressable accepts a callback. Keep the pane width and row semantics.
const nativeStandIn = { ...ReactNative };
mock.module("react-native", () => ({
  ...nativeStandIn,
  View: ({ children, style, ...props }: ViewProps) => {
    const flat = ReactNative.StyleSheet.flatten(style);
    return (
      <div
        role={props.role}
        aria-hidden={props["aria-hidden"]}
        style={{
          display: flat?.display,
          flexDirection: flat?.flexDirection,
          width: typeof flat?.width === "number" ? flat.width : undefined,
        }}
      >
        {children}
      </div>
    );
  },
  Pressable: ({
    children,
    onPress,
    ...props
  }: Omit<PressableProps, "onPress"> &
    Pick<AriaAttributes, "aria-current"> & { onPress?: () => void }) =>
    createElement(
      "div",
      {
        role: props.role,
        "aria-label": props["aria-label"],
        "aria-current": props["aria-current"],
        "data-pressable": true,
        "data-native-selected": props["aria-selected"],
        onClick: onPress,
      },
      typeof children === "function"
        ? children({ pressed: false, hovered: false })
        : children
    ),
}));

const { default: ReservationsRoute } = await import(
  "../../../app/(account)/(tabs)/reservations/index"
);
const { default: ReservationsLayout } = await import(
  "../../../app/(account)/(tabs)/reservations/_layout"
);
const { default: ReservationStatusRoute } = await import(
  "../../../app/(account)/(tabs)/reservations/[orderId]/index"
);
const { OrderStatusScreen, ReservationPaneHeading } = await import(
  "./order-status-screen"
);
const { ReservationsListScreen } = await import("./reservations-list-screen");
const { StatusBarObserverContext } = await import(
  "../../ui/focused-status-bar"
);
const { SplitPane } = await import("../../ui/split-pane");
const { ToastProvider } = await import("../../ui/toast");

const root = clientRoot({ keepFetch: true });
const pressables = (selector = "[data-pressable]") =>
  root.container().querySelectorAll<HTMLElement>(selector);

const fixture = async (
  history: "upcoming" | "empty" | "four-past",
  account: "available" | "loading" | "failed" | "gated" = "available"
) => {
  const kind = account === "gated" ? "completion-required" : "linked";
  const workspace = withSampleHistory(
    FakeWorkspace.forKind(kind),
    history === "four-past" ? "nothing-upcoming" : history
  );
  if (history === "four-past") {
    const row = workspace.data.history.past[0];
    if (row === undefined) throw new Error("Expected a sample past booking");
    workspace.data = {
      ...workspace.data,
      invited: { current: [], past: [] },
      history: {
        ...workspace.data.history,
        past: Array.from({ length: 4 }, (_, index) => ({
          ...row,
          id: `fixture-past-${index}`,
          orderId: CustomerReservationOrderId.make(`fixture-order-${index}`),
        })),
      },
    };
  }
  if (account === "loading") workspace.fail("getAccount", "hang");
  if (account === "failed") workspace.fail("getAccount", "service-unavailable");
  const { registry } = makeFakeCustomerData(kind, workspace);
  registry.mount(accountAtom);
  if (account !== "loading") await settle(registry, accountAtom);
  if (account === "available") {
    registry.mount(reservationHistoryAtom);
    await settle(registry, reservationHistoryAtom);
  }
  const statusBars = new Map<symbol, "dark" | "light">();
  const observe = (style: "dark" | "light") => {
    const owner = Symbol();
    statusBars.set(owner, style);
    return () => statusBars.delete(owner);
  };
  const within = (width: number, node: ReactElement, fontScale = 2) => (
    <TestWindowDimensions value={{ width, height: 800, scale: 2, fontScale }}>
      <RegistryContext.Provider value={registry}>
        <AppLocaleProvider locale="en-US">
          <StatusBarObserverContext value={observe}>
            <ToastProvider>{node}</ToastProvider>
          </StatusBarObserverContext>
        </AppLocaleProvider>
      </RegistryContext.Provider>
    </TestWindowDimensions>
  );
  const { error } = console;
  const warnings = spyOn(console, "error").mockImplementation((...args) => {
    if (
      !/incorrect casing|does not recognize the|non-boolean attribute|unrecognized in this browser|Unknown event handler property/.test(
        String(args[0])
      )
    ) {
      error(...args);
    }
  });
  return {
    registry,
    workspace,
    within,
    statusBars,
    render: (width: number, node: ReactElement, fontScale?: number) =>
      root.render(within(width, node, fontScale)),
    dispose: async () => {
      await root.render(null);
      warnings.mockRestore();
      registry.dispose();
    },
  };
};

test("an empty Reservations list leaves the expanded detail blank", async () => {
  const screen = await fixture("empty");
  try {
    await screen.render(1024, <ReservationsRoute />);
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(1);
    expect(root.container().querySelector("[aria-current]")).toBeNull();
    expect(root.container().querySelector('[style*="400px"]')).not.toBeNull();
    expect([...screen.statusBars.values()]).toEqual(["dark"]);
  } finally {
    await screen.dispose();
  }
});

test.each(["loading", "failed", "gated"] as const)(
  "the expanded list keeps a blank detail when the account is %s",
  async (account) => {
    const screen = await fixture("upcoming", account);
    try {
      await screen.render(1024, <ReservationsRoute />);
      expect(root.container().querySelectorAll("scrollview")).toHaveLength(1);
      expect(root.container().querySelector('[style*="400px"]')).not.toBeNull();
      expect(root.container().querySelector("[aria-current]")).toBeNull();
      expect([...screen.statusBars.values()]).toEqual(["dark"]);
      expect(screen.workspace.calls).not.toContain("listReservations");
      expect(screen.workspace.calls).not.toContain("getReservationStatus");
    } finally {
      await screen.dispose();
    }
  }
);

test("the past list stays expanded while opening one of its bookings", async () => {
  const screen = await fixture("four-past");
  const bookings = () => pressables('[data-pressable][role="link"]');
  try {
    activeRoute = <ReservationsRoute />;
    await screen.render(1024, <ReservationsLayout />);
    expect(bookings()).toHaveLength(2);
    expect(root.container().querySelector("[aria-current]")).toBeNull();
    const label = m.reservations_show_all_past({}, { locale: "en-US" });
    const showAll = Array.from(pressables()).find(
      (button) => button.textContent === label
    );
    if (showAll === undefined) throw new Error("Expected past list expansion");
    await act(async () => showAll.click());
    expect(bookings()).toHaveLength(4);
    const fourth = screen.workspace.data.history.past[3]?.orderId;
    const third = screen.workspace.data.history.past[2]?.orderId;
    if (fourth === undefined || third === undefined)
      throw new Error("Expected four past bookings");
    await act(async () => bookings()[3]?.click());
    expect(router.push).toHaveBeenLastCalledWith(orderStatusHref(fourth));

    params = { orderId: fourth };
    activeRoute = <ReservationStatusRoute />;
    await screen.render(1024, <ReservationsLayout />);
    expect(bookings()).toHaveLength(4);
    await act(async () => bookings()[2]?.click());
    expect(router.replace).toHaveBeenLastCalledWith(orderStatusHref(third));
  } finally {
    router.push.mockClear();
    router.replace.mockClear();
    activeRoute = undefined;
    await screen.dispose();
  }
});

test("the featured preview keeps its order through a list change and resize", async () => {
  const screen = await fixture("upcoming");
  try {
    await screen.render(1024, <ReservationsRoute />);
    const preview = root.container().querySelectorAll("scrollview")[1];
    expect(preview).toBeDefined();
    expect(root.container().querySelector("[aria-current]")).not.toBeNull();
    const { history } = screen.workspace.data;
    screen.workspace.data = {
      ...screen.workspace.data,
      history: { ...history, current: history.current.slice(1) },
    };
    await act(async () => {
      screen.registry.refresh(reservationHistoryAtom);
      await settle(screen.registry, reservationHistoryAtom);
    });
    expect(root.container().querySelectorAll("scrollview")[1]).toBe(preview);
    expect(root.container().querySelector("[aria-current]")).toBeNull();
    await screen.render(600, <ReservationsRoute />);
    expect(preview?.closest('[aria-hidden="true"]')).not.toBeNull();
    await screen.render(1024, <ReservationsRoute />);
    expect(root.container().querySelectorAll("scrollview")[1]).toBe(preview);
  } finally {
    await screen.dispose();
  }
});

test("returning from a missing featured preview clears the selection and refreshes the list", async () => {
  const screen = await fixture("upcoming");
  const orderId = screen.workspace.data.history.current[0]?.orderId;
  if (orderId === undefined) throw new Error("Expected a featured booking");
  const orders = new Map(screen.workspace.data.orders);
  orders.delete(orderId);
  screen.workspace.data = { ...screen.workspace.data, orders };
  const reads = (endpoint: string) =>
    screen.workspace.calls.filter((call) => call === endpoint).length;
  try {
    runFocusEffects = true;
    await screen.render(1024, <ReservationsRoute />);
    await act(async () => {
      await settle(screen.registry, orderStatusAtoms.status(orderId));
    });
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(2);
    const label = m.reservations_go_to_list({}, { locale: "en-US" });
    const goToList = Array.from(pressables()).find(
      (button) => button.textContent === label
    );
    if (goToList === undefined) throw new Error("Expected a missing preview");
    const initialReads = reads("listReservations");
    await act(async () => {
      goToList.click();
      await settle(screen.registry, reservationHistoryAtom);
    });
    expect(reads("listReservations")).toBeGreaterThan(initialReads);
    expect(reads("getReservationStatus")).toBe(1);
    expect(root.container().querySelector("[aria-current]")).toBeNull();
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(1);
  } finally {
    runFocusEffects = false;
    await screen.dispose();
  }
});

test("split-pane reservation titles have full row width at large text sizes", async () => {
  const screen = await fixture("upcoming");
  const stacked = () =>
    root
      .container()
      .querySelector(
        '[data-pressable][role="link"] > div > div[style*="flex-direction: column"]'
      );
  try {
    await screen.render(1280, <ReservationsRoute />, 1);
    expect(stacked()).toBeNull();
    await screen.render(1280, <ReservationsRoute />, 2);
    expect(stacked()).not.toBeNull();
  } finally {
    await screen.dispose();
  }
});

test("a linked detail and its selected row survive the split breakpoint at 200% font size", async () => {
  const screen = await fixture("upcoming");
  const orderId = screen.workspace.data.history.current[0]?.orderId;
  if (orderId === undefined) throw new Error("Expected a selectable booking");
  params = { orderId };
  try {
    await screen.render(1023, <ReservationStatusRoute />);
    expect(screenOptions?.headerShown).toBe(true);
    const detail = root.container().querySelector("scrollview");
    expect(detail).not.toBeNull();
    await screen.render(1024, <ReservationStatusRoute />);
    expect(screenOptions?.headerShown).toBe(false);
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(2);
    expect(root.container().querySelector('[style*="400px"]')).not.toBeNull();
    const selected = root.container().querySelectorAll('[aria-current="page"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-native-selected")).toBe("true");
    expect([...screen.statusBars.values()]).toEqual(["dark"]);
    await screen.render(600, <ReservationStatusRoute />);
    expect(screenOptions?.headerShown).toBe(true);
    expect(root.container().querySelectorAll("scrollview")).toHaveLength(1);
    expect(root.container().querySelector("scrollview")).toBe(detail);
    expect(router.replace).not.toHaveBeenCalled();
  } finally {
    await screen.dispose();
  }
});

test("selecting another wide booking replaces the route and payment return closes to Reservations", async () => {
  const screen = await fixture("upcoming");
  const [first, second] = screen.workspace.data.history.current;
  if (first?.orderId === undefined || second?.orderId === undefined) {
    throw new Error("Expected two selectable bookings");
  }
  params = { orderId: first.orderId, after: "payment" };
  try {
    await screen.render(1024, <ReservationStatusRoute />);
    const close = pressables(
      `[data-pressable][aria-label="${m.navigation_close({}, { locale: "en-US" })}"]`
    )[0];
    expect(close).toBeDefined();
    expect(close?.closest("scrollview")).toBeNull();

    const tree = elementTree(ReservationStatusRoute, {}, (node) =>
      screen.within(1024, node)
    );
    const split = find(tree, SplitPane)?.props;
    const list = find(split?.list, ReservationsListScreen)?.props?.selection;
    list?.onSelect(first.orderId);
    expect(router.replace).not.toHaveBeenCalled();
    list?.onSelect(second.orderId);
    expect(router.replace).toHaveBeenCalledWith(
      orderStatusHref(second.orderId)
    );
    const heading = find(
      find(split?.children, OrderStatusScreen)?.props.heading,
      ReservationPaneHeading
    );
    expect(heading?.props.closes).toBe(true);
    heading?.props.onBack?.();
    expect(router.dismissTo).toHaveBeenCalledWith(reservationsHref);
    expect(router.back).not.toHaveBeenCalled();
  } finally {
    await screen.dispose();
  }
});
