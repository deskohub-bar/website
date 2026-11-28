import type {
  CustomerBookedSelection,
  CustomerReservationFamily,
} from "@deskohub/workspace-customer-api";
import type { Option } from "effect";
import { useIsFocused, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { trackBookingStarted } from "../../analytics/events";
import { bookingPreselectionOf } from "../booking-preselection";
import type { CheckoutRestartReason } from "../checkout/booking-problem";
import {
  type BookingFamily,
  reservationKindOf,
} from "../selection/booking-selection";
import { useRestartReasonInView } from "./restart-reason";

/** Reports the booking started once, when the family's screen opens. */
export const useBookingStarted = (family: BookingFamily) => {
  useEffect(() => {
    trackBookingStarted(reservationKindOf(family));
  }, [family]);
};

/**
 * Why checkout sent the customer back here, from the `restart` parameter,
 * while the screen is in view (see `useRestartReasonInView`).
 */
export const useRestartReason = (
  reread: () => void,
  { refreshOnOpen = false }: { readonly refreshOnOpen?: boolean } = {}
): Option.Option<CheckoutRestartReason> => {
  const { restart } = useLocalSearchParams<{ restart?: string }>();
  return useRestartReasonInView(restart, useIsFocused(), reread, refreshOnOpen);
};

/**
 * The selection the family's screen was opened with ("Book again"), from
 * its route params; none when it opened empty.
 */
export const useBookingPreselection = (
  family: CustomerReservationFamily
): Option.Option<CustomerBookedSelection> =>
  bookingPreselectionOf(family, useLocalSearchParams());
