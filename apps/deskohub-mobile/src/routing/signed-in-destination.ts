import type { NavigationState } from "expo-router/react-navigation";
import type { BookingFamily } from "../booking/selection/booking-selection";

export type SignedInDestination = BookingFamily | "account" | "reservations";

/** The same route groups stay in use at every width. */
export function signedInDestination(
  segments: readonly string[],
  checkoutFamily?: BookingFamily
): SignedInDestination | undefined {
  const [, group, screen] = segments;
  if (group === "(tabs)") {
    if (screen === "account" || screen === "reservations") return screen;
    return undefined;
  }
  if (group === "reservations") return "reservations";
  if (group !== "book") return undefined;
  switch (screen) {
    case "cowork":
    case "office":
    case "meeting-room":
    case "table":
      return screen;
    case "checkout":
    case "profile":
      return checkoutFamily;
    default:
      return undefined;
  }
}

/** Switch Choose screens without leaving checkout or its Profile in Back. */
export function bookingFamilyReset(
  root: NavigationState | undefined,
  family: BookingFamily
) {
  const slot = root?.routes[root.index];
  // Expo Router hosts the app's Stack under its container route.
  const app = slot?.name === "__root" ? slot.state : root;
  if (app?.stale !== false) return undefined;
  const current = app.routes[app.index];
  if (current?.name !== "(account)" || current.state?.stale !== false) {
    return undefined;
  }
  const { state: account } = current;
  const route = account.routes[account.index];
  const book = route?.name === "book" ? route.state : undefined;
  if (book?.stale !== false) return undefined;

  // One removal action lets the existing dirty Profile guard replay or cancel
  // the entire switch. Expo Router requires the complete stack state here.
  return {
    state: {
      ...book,
      index: 0,
      routes: [{ name: family }],
    },
    target: book.key,
  };
}
