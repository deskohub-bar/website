import { expect, mock, spyOn, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { RegistryContext } from "@effect/atom-react";
import type { Href } from "expo-router";
import { act, createContext, createElement, useContext } from "react";
import type {
  ModalProps,
  PressableProps,
  TextInputProps,
  ViewProps,
} from "react-native";
import * as ReactNative from "react-native";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { clientRoot } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { emailWithBreak } from "../../ui/email-with-break";
import { teamTableBookAgainHref } from "../booking-preselection";
import { checkoutRequestAtom } from "../checkout/checkout-flow";
import { teamTableCalendarAtom } from "../data/booking-queries";
import { fakeHoldDuration } from "../testing/fake-booking-api";
import { makeFakeCheckout } from "../testing/fake-checkout";
import { detailsDraftAtom } from "./details-draft";

const RouteContext = createContext({ focused: true, search: "" });
const router = {
  push: mock((_href: Href) => undefined),
  dismissTo: mock((_href: Href) => undefined),
};

mock.module("expo-router", () => ({
  ...expoRouterStandIn({
    useRouter: () => router,
    useIsFocused: () => useContext(RouteContext).focused,
    useNavigation: () => {
      const { focused } = useContext(RouteContext);
      return { isFocused: () => focused };
    },
    useLocalSearchParams: () =>
      Object.fromEntries(new URLSearchParams(useContext(RouteContext).search)),
  }),
  Stack: { Screen: () => null },
}));

// Expose native controls to the DOM while keeping the production form,
// review, and dialog mounted and running their own React code.
const native = { ...ReactNative };
mock.module("react-native", () => ({
  ...native,
  View: (props: ViewProps) =>
    createElement(
      "div",
      { role: props.role, "aria-label": props["aria-label"] },
      props.children
    ),
  Pressable: ({
    children,
    disabled,
    onPress,
    ...props
  }: Omit<PressableProps, "onPress"> & { onPress?: () => void }) => (
    <button
      type="button"
      role={props.role}
      aria-label={props["aria-label"] ?? props.accessibilityLabel}
      data-native-selected={props["aria-selected"]}
      data-native-checked={props["aria-checked"]}
      disabled={disabled ?? undefined}
      onClick={onPress}
    >
      {typeof children === "function"
        ? children({ pressed: false, hovered: false })
        : children}
    </button>
  ),
  TextInput: ({ value, onChangeText, "aria-label": label }: TextInputProps) => (
    <input
      aria-label={label}
      value={value}
      onInput={(event) => onChangeText?.(event.currentTarget.value)}
    />
  ),
  Modal: ({ visible, children }: ModalProps) => (visible ? children : null),
}));

const { default: Book } = await import("../../../app/(account)/(tabs)/book");
const { default: Cowork } = await import("../../../app/(account)/book/cowork");
const { default: TeamTable } = await import(
  "../../../app/(account)/book/table"
);
const { default: Checkout } = await import(
  "../../../app/(account)/book/checkout"
);
const { ToastProvider } = await import("../../ui/toast");

const root = clientRoot({ keepFetch: true });
const language = { locale: "en-US" } as const;
const button = (label: string, within: ParentNode = root.container()) =>
  Array.from(within.querySelectorAll("button")).find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) === label
  );

const waitFor = async <A,>(read: () => A | null | undefined, label: string) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = read();
    if (value != null) return value;
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error(`Could not find ${label}`);
};

const press = async (label: string, within?: ParentNode) => {
  const control = await waitFor(() => {
    const found = button(label, within);
    return found?.disabled === false ? found : undefined;
  }, label);
  await act(async () => control.click());
};

const field = (label: string) =>
  root
    .container()
    .querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

const fill = async (label: string, value: string) => {
  const input = await waitFor(() => field(label), label);
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const silenceNativeWarnings = () => {
  const { error } = console;
  return spyOn(console, "error").mockImplementation((...args) => {
    if (
      !/incorrect casing|does not recognize the|non-boolean attribute|unrecognized in this browser|Unknown event handler property/.test(
        String(args[0])
      )
    ) {
      error(...args);
    }
  });
};

const showTeamTable = (
  checkout: Awaited<ReturnType<typeof makeFakeCheckout>>,
  { checkingOut = false, restarting = false } = {}
) => {
  const href = teamTableBookAgainHref({
    family: "table",
    seats: 1,
    date: checkout.booking.dateIn(20),
    startTime: "10:00",
    endTime: "10:15",
  });
  const query = new URLSearchParams(href.split("?")[1]);
  if (restarting) query.set("restart", "hold_expired");
  return root.render(
    <RegistryContext.Provider value={checkout.registry}>
      <AppLocaleProvider locale={language.locale}>
        <ToastProvider>
          <RouteContext.Provider
            value={{ focused: true, search: query.toString() }}
          >
            {checkingOut ? <Checkout /> : <TeamTable />}
          </RouteContext.Provider>
        </ToastProvider>
      </AppLocaleProvider>
    </RegistryContext.Provider>
  );
};

test("a failed Team Table calendar refresh can be retried before checkout", async () => {
  const checkout = await makeFakeCheckout();
  checkout.booking.tableSeats = [1];
  const continueLabel = m.booking_continue({}, language);
  const warnings = silenceNativeWarnings();
  try {
    await showTeamTable(checkout);
    await waitFor(
      () => button(continueLabel)?.disabled === false || undefined,
      "available preselection"
    );
    checkout.workspace.fail("getAvailability", "service-unavailable");
    await act(async () =>
      checkout.registry.refresh(teamTableCalendarAtom({ seats: 1 }))
    );
    await press(m.account_retry({}, language));
    await press(continueLabel);
    expect(router.push).toHaveBeenLastCalledWith("/book/checkout");
  } finally {
    await root.render(null);
    checkout.dispose();
    warnings.mockRestore();
  }
});

test("a contact can book the only Team Table seat for an invitee", async () => {
  const checkout = await makeFakeCheckout();
  checkout.booking.tableSeats = [1];
  const guest = testEmailAddress("solo-team-guest");
  const warnings = silenceNativeWarnings();
  try {
    await showTeamTable(checkout);
    await press(m.booking_office_person_remove_you({}, language));
    expect(button(m.booking_continue({}, language))?.disabled).toBe(true);
    await fill(m.booking_office_person_email_label({}, language), guest);
    await press(m.booking_office_person_add({}, language));
    await press(m.booking_continue({}, language));
    expect(checkout.registry.get(checkoutRequestAtom)).toMatchObject({
      _tag: "Some",
      value: { people: { contactAttends: false, invitees: [guest] } },
    });
    await showTeamTable(checkout, { checkingOut: true });
    await press(m.booking_details_continue({}, language));
    await waitFor(
      () =>
        root.container().textContent?.includes(emailWithBreak(guest)) ||
        undefined,
      "guest in checkout review"
    );
    expect(root.container().textContent).toContain("Alex Sample");
  } finally {
    await root.render(null);
    checkout.dispose();
    warnings.mockRestore();
  }
});

test("Team Table restart refreshes the concrete availability and quote from shared caches", async () => {
  const checkout = await makeFakeCheckout();
  checkout.booking.tableSeats = [1];
  const warnings = silenceNativeWarnings();
  const ready = () =>
    button(m.booking_continue({}, language))?.disabled === false || undefined;
  try {
    await showTeamTable(checkout);
    await waitFor(ready, "initial quote");
    await root.render(null);
    const before = checkout.workspace.calls.length;
    await showTeamTable(checkout, { restarting: true });
    await waitFor(
      () =>
        checkout.workspace.calls.slice(before).includes("getQuote") ||
        undefined,
      "fresh quote after restart"
    );
    await waitFor(ready, "continue after a fresh quote");
    expect(checkout.workspace.calls.slice(before)).toEqual(
      expect.arrayContaining(["getAvailability", "getSlots", "getQuote"])
    );
  } finally {
    await root.render(null);
    checkout.dispose();
    warnings.mockRestore();
  }
});

test("a Team Table quote that loses its slot refreshes the shown times", async () => {
  const checkout = await makeFakeCheckout();
  checkout.booking.tableSeats = [1];
  const warnings = silenceNativeWarnings();
  try {
    await showTeamTable(checkout);
    await waitFor(
      () => button(m.booking_team_table_start({}, language)),
      "initial slots"
    );
    checkout.booking.unavailableDates = [checkout.booking.dateIn(20)];
    await waitFor(
      () =>
        root
          .container()
          .textContent?.includes(m.booking_team_table_no_times({}, language)) ||
        undefined,
      "updated unavailable times"
    );
    expect(
      checkout.workspace.calls.filter((call) => call === "getSlots")
    ).toHaveLength(2);
    expect(button(m.booking_continue({}, language))?.disabled).toBe(true);
  } finally {
    await root.render(null);
    checkout.dispose();
    warnings.mockRestore();
  }
});

test("an expired hold keeps the review visible and offers the selection or Book", async () => {
  const checkout = await makeFakeCheckout();
  const guest = {
    name: "Casey Guest",
    email: testEmailAddress("guest"),
    phone: "+420600000321",
  };
  const guestFields = [
    [m.booking_details_their_name({}, language), guest.name],
    [m.booking_details_their_email({}, language), guest.email],
    [m.booking_details_their_phone({}, language), guest.phone],
  ] as const;
  // As in the book stack, the selection stays mounted under checkout.
  const show = (href: string) => {
    const checkingOut = href === "/book/checkout";
    const choosing = href === "/book";
    return root.render(
      <RegistryContext.Provider value={checkout.registry}>
        <AppLocaleProvider locale={language.locale}>
          <ToastProvider>
            {choosing ? (
              <Book />
            ) : (
              <section hidden={checkingOut} aria-label="Selection">
                <RouteContext.Provider
                  value={{
                    focused: !checkingOut,
                    search: href.split("?")[1] ?? "",
                  }}
                >
                  <Cowork />
                </RouteContext.Provider>
              </section>
            )}
            {checkingOut && (
              <section aria-label="Checkout">
                <Checkout />
              </section>
            )}
          </ToastProvider>
        </AppLocaleProvider>
      </RegistryContext.Provider>
    );
  };
  const checkoutContent = () =>
    root.container().querySelector('[aria-label="Checkout"]');
  const dialog = () =>
    checkoutContent()?.querySelector<HTMLElement>('[role="alertdialog"]') ??
    null;
  const selection = () =>
    root.container().querySelector<HTMLElement>('[aria-label="Selection"]');

  const openCheckout = async () => {
    const previousPushes = router.push.mock.calls.length;
    await press(
      m.booking_continue({}, language),
      await waitFor(selection, "selection")
    );
    expect(router.push.mock.calls.slice(previousPushes)).toEqual([
      ["/book/checkout"],
    ]);
    await show("/book/checkout");
  };
  const expireOnReview = async () => {
    await press(m.booking_details_continue({}, language));
    const progress = m.booking_steps_progress(
      { current: "3", total: "3", step: m.booking_steps_pay({}, language) },
      language
    );
    const review = () =>
      checkoutContent()?.querySelector(
        `[role="group"][aria-label="${progress}"]`
      );
    await waitFor(review, "review step");
    expect(checkoutContent()?.textContent).toContain(guest.name);
    expect(dialog()).toBeNull();
    const departures = router.dismissTo.mock.calls.length;
    const pushes = router.push.mock.calls.length;
    const endedAt = new Date(
      checkout.booking.now().getTime() + fakeHoldDuration
    );
    checkout.booking.now = () => endedAt;
    await act(() => checkout.adjust(fakeHoldDuration));
    const overReview = await waitFor(dialog, "hold-ended dialog");
    expect(router.dismissTo).toHaveBeenCalledTimes(departures);
    expect(router.push).toHaveBeenCalledTimes(pushes);
    expect(review()).toBeTruthy();
    expect(checkoutContent()?.textContent).toContain(guest.name);
    return overReview;
  };

  const warnings = silenceNativeWarnings();
  try {
    await show("/book/cowork");
    const calendar = await waitFor(
      () =>
        selection()?.querySelector(
          `[role="group"][aria-label="${m.booking_date_heading({}, language)}"]`
        ),
      "booking calendar"
    );
    const availableDay = () =>
      calendar.querySelector<HTMLButtonElement>(
        `button[data-native-selected=false]:not(:disabled):not([aria-label$=", ${m.booking_calendar_today_day({}, language)}"])`
      );
    if (availableDay() === null) {
      await press(m.booking_calendar_next_month({}, language), calendar);
    }
    const day = await waitFor(availableDay, "an available day");
    const date = day.getAttribute("aria-label");
    await act(async () => day.click());
    await press("Coffee");
    await openCheckout();

    await press(m.booking_details_who_someone_else({}, language));
    for (const [label, value] of guestFields) await fill(label, value);
    await press(
      m.booking_hold_ended_check_date({}, language),
      await expireOnReview()
    );
    expect(router.dismissTo).toHaveBeenLastCalledWith(
      "/book/cowork?restart=hold_expired"
    );
    await show("/book/cowork?restart=hold_expired");
    const keptSelection = await waitFor(selection, "selection after expiry");
    expect(
      keptSelection
        .querySelector(`button[aria-label="${date}"]`)
        ?.getAttribute("data-native-selected")
    ).toBe("true");
    expect(
      button("Coffee", keptSelection)?.getAttribute("data-native-checked")
    ).toBe("true");

    await openCheckout();
    for (const [label, value] of guestFields) {
      expect((await waitFor(() => field(label), label)).value).toBe(value);
    }
    await press(
      m.booking_hold_ended_leave({}, language),
      await expireOnReview()
    );
    expect(router.dismissTo).toHaveBeenLastCalledWith("/book");
    await show("/book");
    await waitFor(
      () =>
        root
          .container()
          .querySelector(
            `[role="link"][aria-label^="${m.booking_family_cowork_title({}, language)}"]`
          ),
      "Book tab space chooser"
    );
    expect(checkout.registry.get(detailsDraftAtom)).toMatchObject({
      _tag: "Some",
      value: { bookingFor: "someone-else", someoneElse: guest },
    });
  } finally {
    await root.render(null);
    checkout.dispose();
    warnings.mockRestore();
  }
});
