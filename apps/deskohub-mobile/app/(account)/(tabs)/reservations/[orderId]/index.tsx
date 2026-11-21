import { CustomerReservationOrderId } from "@deskohub/workspace-customer-api";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  OrderStatusScreen,
  ReservationPaneHeading,
} from "../../../../../src/account/reservations/order-status-screen";
import { ReservationsListScreen } from "../../../../../src/account/reservations/reservations-list-screen";
import { statusVisitOf } from "../../../../../src/account/reservations/status-refresh-rules";
import {
  orderStatusHref,
  reservationsHref,
} from "../../../../../src/booking/booking-routes";
import { useAppLocale } from "../../../../../src/i18n/locale-context";
import { m } from "../../../../../src/i18n/messages";
import {
  renderClosingStackHeader,
  stackScreenOptions,
} from "../../../../../src/ui/navigation";
import { SplitPane } from "../../../../../src/ui/split-pane";
import { useViewport } from "../../../../../src/ui/viewport";

export default function ReservationStatusRoute() {
  // Only `after` matters; other params (such as a preview's bypass) are ignored.
  const { orderId, after } = useLocalSearchParams<{
    orderId: string;
    after?: string;
  }>();
  const locale = useAppLocale();
  const router = useRouter();
  const { isExpanded } = useViewport();
  const id = CustomerReservationOrderId.make(orderId);
  const visit = statusVisitOf(after);
  const closes = visit === "after-payment";
  const close = () => router.dismissTo(reservationsHref);
  return (
    <>
      {/* Straight after payment the booking closes to the Reservations list
          below it (`leaveCheckout`), never back into checkout. */}
      <Stack.Screen
        options={{
          headerShown: !isExpanded,
          title: closes
            ? m.reservations_your_booking({}, { locale })
            : m.reservations_status_title({}, { locale }),
          // Expo merges options for a mounted route when the visit changes.
          header: closes
            ? (props) =>
                renderClosingStackHeader({
                  ...props,
                  back: {
                    title: m.account_section_reservations({}, { locale }),
                    href: reservationsHref,
                  },
                  navigation: { ...props.navigation, goBack: close },
                })
            : stackScreenOptions(locale).header,
        }}
      />
      <SplitPane
        list={
          isExpanded && (
            <ReservationsListScreen
              selection={{
                orderId: id,
                onSelect: (selected) => {
                  if (selected !== id)
                    router.replace(orderStatusHref(selected));
                },
              }}
            />
          )
        }
      >
        <OrderStatusScreen
          key={`${orderId}/${visit}`}
          orderId={id}
          visit={visit}
          heading={
            isExpanded ? (
              <ReservationPaneHeading
                closes={closes}
                onBack={() => {
                  if (closes || !router.canGoBack()) {
                    close();
                  } else {
                    router.back();
                  }
                }}
              />
            ) : undefined
          }
        />
      </SplitPane>
    </>
  );
}
