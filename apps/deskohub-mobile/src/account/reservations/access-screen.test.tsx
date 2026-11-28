import { describe, expect, mock, spyOn, test } from "bun:test";
import { CustomerAccessCodeUnavailable } from "@deskohub/workspace-customer-api";
import { RegistryContext } from "@effect/atom-react";
import { Cause, DateTime, Option } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { NativeStackHeaderProps } from "expo-router";
import { isValidElement, type ReactElement } from "react";
import { reservationsHref } from "../../booking/booking-routes";
import {
  sampleOfficePeopleReservation,
  sampleOrderIds,
  sampleTeamTableReservation,
  sampleWorkspaceData,
} from "../../customer-api/testing/sample-fixtures";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { findAll, hostTree, textOf } from "../../ui/testing/element-tree";
import { reservationAccessAtom } from "./access-screen-state";
import { invitedReservationsAtom } from "./invited-reservations";
import { orderStatusAtoms } from "./order-status-state";
import { reservationProductTitle } from "./reservation-labels";
import { reservationGroups } from "./reservation-list-model";
import { reservationsListAtom } from "./reservations-list-state";
import { AutomaticRefresh } from "./status-refresh-rules";

mock.module("expo-router", () => expoRouterStandIn());
// Contact us only needs the origin, not the native auth client.
mock.module("../../auth/auth-client", () => ({
  apiOrigin: "https://workspace.test",
}));

const { accessStackHeader, ReservationAccessScreen } = await import(
  "./access-screen"
);
const { StackHeader } = await import("../../ui/navigation");
const { ToastProvider } = await import("../../ui/toast");
const navigation = await import("expo-router");

describe("accessStackHeader", () => {
  test("Back from a PIN with nothing behind it opens the Reservations list at every width", () => {
    for (const renderHeader of Object.values(accessStackHeader)) {
      const header = renderHeader({} as NativeStackHeaderProps);
      expect(isValidElement(header) && header.type === StackHeader).toBe(true);
      expect(header.props.backFallback).toBe(reservationsHref);
    }
    const expanded = accessStackHeader.paperWide({} as NativeStackHeaderProps);
    expect(expanded.props.contentWidth).toBe("wide");
  });
});

test("an invitee sees the assigned Team Table and its shared PIN controls", () => {
  const now = new Date();
  const sample = sampleWorkspaceData("linked", now);
  const orderId = sampleOrderIds.teamTable;
  const access = sample.orders.get(orderId)?.access;
  if (access?.tableName === undefined)
    throw new Error("Expected sample Team Table access and an assigned table");
  const row = sampleTeamTableReservation(now);
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        reservationAccessAtom(orderId),
        AsyncResult.success(access)
      ),
      Atom.initialValue(
        invitedReservationsAtom,
        AsyncResult.success({
          current: [
            {
              orderId,
              product: row.product,
              status: "confirmed",
              accessStartsAt: row.startsAt,
              accessEndsAt: row.endsAt,
              bookedBy: { name: "Sam Example" },
            },
          ],
          past: [],
        })
      ),
    ],
  });
  try {
    const locale = "en-US";
    const tree = hostTree(
      <ReservationAccessScreen orderId={orderId} />,
      (node) => (
        <RegistryContext.Provider value={registry}>
          <AppLocaleProvider locale={locale}>
            <ToastProvider>{node}</ToastProvider>
          </AppLocaleProvider>
        </RegistryContext.Provider>
      )
    );
    const labels = findAll(tree, "Text").map(textOf);
    expect(labels).toContain(reservationProductTitle(row.product, locale));
    expect(labels).toContain(access.tableName);
    expect(labels).toContain("Sam Example");
    expect(
      findAll(tree, "Pressable").some(
        (button) =>
          button.props["aria-label"] ===
          m.reservations_access_copy({}, { locale })
      )
    ).toBe(true);
  } finally {
    registry.dispose();
  }
});

test.each([
  ["cold access", false],
  ["an invitation", false],
  ["saved history", false],
  ["fresh own history", true],
  ["the status screen", true],
] as const)("no PIN returns correctly from %s", (entry, returnToStatus) => {
  const now = new Date();
  const at = DateTime.makeUnsafe(now);
  const sample = sampleWorkspaceData("linked", now);
  const orderId =
    entry === "an invitation"
      ? sampleOrderIds.officeInvited
      : sampleOrderIds.officePeople;
  const order = sample.orders.get(orderId)?.state;
  if (!order) throw new Error("Expected sample order");
  const hasRow = entry === "fresh own history" || entry === "saved history";
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        reservationAccessAtom(orderId),
        AsyncResult.failure(Cause.fail(new CustomerAccessCodeUnavailable()))
      ),
      Atom.initialValue(
        invitedReservationsAtom,
        entry === "an invitation" && sample.invited
          ? AsyncResult.success(sample.invited)
          : AsyncResult.initial(true)
      ),
      Atom.initialValue(
        reservationsListAtom,
        hasRow
          ? AsyncResult.success({
              groups: reservationGroups(
                {
                  ...sample.history,
                  current: [sampleOfficePeopleReservation(now)],
                },
                at
              ),
              savedAt:
                entry === "saved history" ? Option.some(at) : Option.none(),
            })
          : AsyncResult.initial(true)
      ),
      Atom.initialValue(
        orderStatusAtoms.status(orderId),
        entry === "the status screen"
          ? AsyncResult.success({
              order,
              reading: false,
              attempt: 0,
              automatic: AutomaticRefresh.Stopped({ reason: "settled" }),
              failure: Option.none(),
            })
          : AsyncResult.initial(true)
      ),
    ],
  });
  const dismissTo = mock();
  const router = spyOn(navigation, "useRouter").mockReturnValue({
    ...navigation.useRouter(),
    dismissTo,
  });
  const within = (node: ReactElement) => (
    <RegistryContext.Provider value={registry}>
      <AppLocaleProvider locale="en-US">{node}</AppLocaleProvider>
    </RegistryContext.Provider>
  );
  try {
    const tree = hostTree(
      <ReservationAccessScreen orderId={orderId} />,
      within
    );
    const locale = { locale: "en-US" } as const;
    const contact = m.reservations_contact({}, locale);
    const back = findAll(tree, "Pressable").find(
      (button) =>
        button.props.role === "button" &&
        !findAll(button, "Text").some((label) => textOf(label) === contact)
    );
    const press = back?.props.onPress;
    if (typeof press !== "function")
      throw new Error("Expected a return button");
    press();
    expect(dismissTo).toHaveBeenCalledWith(
      returnToStatus
        ? { pathname: "/reservations/[orderId]", params: { orderId } }
        : reservationsHref
    );
    expect(findAll(back, "Text").map(textOf)).toContain(
      returnToStatus
        ? m.reservations_access_back_to_booking({}, locale)
        : m.account_section_reservations({}, locale)
    );
  } finally {
    router.mockRestore();
    registry.dispose();
  }
});
