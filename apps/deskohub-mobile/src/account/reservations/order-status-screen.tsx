import type { CustomerReservationOrderId } from "@deskohub/workspace-customer-api";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { DateTime, Match, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  type Href,
  useFocusEffect,
  useIsFocused,
  useNavigation,
  useRouter,
} from "expo-router";
import CalendarPlus from "lucide-react-native/icons/calendar-plus";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Download from "lucide-react-native/icons/download";
import FileText from "lucide-react-native/icons/file-text";
import Mail from "lucide-react-native/icons/mail";
import RotateCcw from "lucide-react-native/icons/rotate-ccw";
import Search from "lucide-react-native/icons/search";
import Undo2 from "lucide-react-native/icons/undo-2";
import {
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { teamTableBookAgainHref } from "../../booking/booking-preselection";
import {
  bookAgainHref,
  bookFamilyHref,
  reservationsHref,
} from "../../booking/booking-routes";
import { AsyncView, viewErrorOf } from "../../customer-api/async-view";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import {
  type CustomerRequestFailure,
  CustomerViewError,
} from "../../customer-api/customer-view-error";
import { sharedViewErrorMessage } from "../../customer-api/customer-view-error-message";
import {
  DownloadShareFailure,
  downloadShareFailureOf,
} from "../../customer-api/share-downloaded-file";
import type { AppLocale } from "../../i18n/app-locale";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";
import { openContactPage } from "../../routing/open-contact-page";
import { AppBar } from "../../ui/app-bar";
import { Card } from "../../ui/card";
import { Button, LiveMessage } from "../../ui/controls";
import { EmptyState } from "../../ui/empty-state";
import { FocusedStatusBar } from "../../ui/focused-status-bar";
import { Icon } from "../../ui/icon";
import { ListGroup, ListRow } from "../../ui/list";
import { useLiveRegionAnnouncement } from "../../ui/live-announcement";
import { Notice } from "../../ui/notice";
import { ScrollScreen } from "../../ui/scroll-screen";
import { Text } from "../../ui/text";
import { color, space } from "../../ui/tokens";
import { useContentColumn } from "../../ui/viewport";
import { AccessPinButton } from "./access-pin-button";
import {
  BookingSteps,
  BookingTicket,
  BookingTicketSkeleton,
} from "./booking-ticket";
import {
  type BookingTicketModel,
  orderCheckingOf,
  orderTicketModel,
} from "./booking-ticket-model";
import { ticketBadge, ticketSteps } from "./booking-ticket-text";
import { type BookingEvent, calendarShareAtom } from "./calendar-event";
import { establishmentAtom } from "./establishment";
import { invoiceShareAtom } from "./invoice-share";
import { OrderPeopleSection } from "./order-people-section";
import { offersAccessLink, offersInvoice } from "./order-status-kind";
import {
  focusGained,
  focusLost,
  focusVisibility,
  orderStatusAtoms,
  restartStatusVisit,
} from "./order-status-state";
import { orderTicketView, reservationOfOrderAtom } from "./order-ticket-view";
import { bookedSelectionOf } from "./payment-recovery";
import {
  canRefreshManually,
  type ReservationOrder,
  type StatusRefreshState,
} from "./status-refresh";
import { AutomaticRefresh, type StatusVisit } from "./status-refresh-rules";
import { teamTableSelectionOfReservation } from "./team-table-rebooking";
import { usePaymentRecovery } from "./use-payment-recovery";
import { WhenWithdrawable } from "./withdrawal-offer";

const invoiceFailureMessage = (
  failure: DownloadShareFailure,
  locale: AppLocale
) =>
  DownloadShareFailure.$match(failure, {
    Share: () => m.reservations_invoice_share_failed({}, { locale }),
    Download: ({ error }) =>
      Match.value(error).pipe(
        Match.tag("InvoiceNotIssued", () =>
          m.reservations_invoice_not_issued({}, { locale })
        ),
        Match.tag("NotFound", () =>
          m.reservations_invoice_not_found({}, { locale })
        ),
        Match.orElse(
          (other) =>
            sharedViewErrorMessage(other, locale) ??
            m.account_error_unexpected({}, { locale })
        )
      ),
  });

/** Calendar, invoice and Contact us: the quiet rows under a confirmed ticket. */
function MoreActions({
  order,
  event,
  invoiceAllowed,
  withdrawn = false,
  announce,
}: {
  readonly order: ReservationOrder;
  readonly invoiceAllowed: boolean;
  /** Withdrawn from already: no second withdrawal. */
  readonly withdrawn?: boolean;
  /** The booking as a calendar event; none while its times are unknown. */
  readonly event: BookingEvent | undefined;
  readonly announce: boolean;
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const invoice = useAtomValue(invoiceShareAtom(order.orderId));
  const shareInvoice = useAtomSet(invoiceShareAtom(order.orderId));
  const calendar = useAtomValue(calendarShareAtom(order.orderId));
  const shareEvent = useAtomSet(calendarShareAtom(order.orderId));
  const failure = AsyncResult.isFailure(invoice)
    ? downloadShareFailureOf(invoice.cause)
    : undefined;
  return (
    <>
      <ListGroup>
        {event !== undefined && (
          <ListRow
            kind="action"
            icon={CalendarPlus}
            label={m.reservations_add_to_calendar({}, { locale })}
            trailing="none"
            disabled={calendar.waiting}
            onPress={() => shareEvent(event)}
          />
        )}
        {invoiceAllowed && offersInvoice(order) && (
          <ListRow
            kind="action"
            icon={FileText}
            label={m.reservations_invoice_row({}, { locale })}
            trailing={<Icon icon={Download} size={20} color={color.ink3} />}
            disabled={invoice.waiting}
            onPress={() => shareInvoice()}
          />
        )}
        <ListRow
          kind="action"
          icon={Mail}
          label={m.reservations_contact({}, { locale })}
          trailing={<Icon icon={ChevronRight} size={20} color={color.ink3} />}
          onPress={() => openContactPage()}
        />
        {!withdrawn && !order.reservationCancelled && (
          <WhenWithdrawable orderId={order.orderId}>
            <ListRow
              kind="action"
              destructive
              icon={Undo2}
              label={m.reservationWithdrawalAction({}, { locale })}
              trailing={
                <Icon icon={ChevronRight} size={20} color={color.ink3} />
              }
              onPress={() =>
                router.push({
                  pathname: "/reservations/[orderId]/withdraw",
                  params: { orderId: order.orderId },
                })
              }
            />
          </WhenWithdrawable>
        )}
      </ListGroup>
      <LiveMessage
        role="status"
        message={
          announce && invoice.waiting
            ? m.reservations_invoice_preparing({}, { locale })
            : undefined
        }
      />
      <LiveMessage
        role="alert"
        message={
          !announce || failure === undefined
            ? undefined
            : invoiceFailureMessage(failure, locale)
        }
      />
      <LiveMessage
        role="alert"
        message={
          announce && AsyncResult.isFailure(calendar)
            ? m.reservations_calendar_share_failed({}, { locale })
            : undefined
        }
      />
    </>
  );
}

/** A quiet Contact us under a ticket whose booking needs help or ended. */
function ContactLink() {
  const locale = useAppLocale();
  return (
    <Button
      variant="quiet"
      icon={Mail}
      label={m.reservations_contact({}, { locale })}
      onPress={() => openContactPage()}
    />
  );
}

/** What stands under the perforation for the ticket's state. */
function TicketStub({
  model,
  order,
  rebookingHref,
  accessAllowed,
  accessHint,
  checking,
  onCheckAgain,
  paymentPageAction,
  retryPaymentAction,
}: {
  readonly model: BookingTicketModel;
  readonly order: ReservationOrder;
  /** What the order books, for Book again. */
  readonly rebookingHref: Href;
  readonly accessAllowed: boolean;
  readonly accessHint: string | undefined;
  /** A read the customer asked for is under way. */
  readonly checking: boolean;
  readonly onCheckAgain: () => void;
  /** Opens the order's payment page again. */
  readonly paymentPageAction: ReactNode;
  /** Pays the order again, its details kept. */
  readonly retryPaymentAction: ReactNode;
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const { stub } = model;
  switch (stub._tag) {
    case "AccessPin":
      return accessAllowed && offersAccessLink(order) ? (
        <>
          <AccessPinButton orderId={order.orderId} />
          {accessHint !== undefined && (
            <Text variant="hint" style={styles.centred}>
              {accessHint}
            </Text>
          )}
        </>
      ) : null;
    case "BookAgain":
      return (
        <>
          {stub.refundNote && (
            <Text variant="bodySmall" tone="default">
              {m.reservations_refund_note({}, { locale })}
            </Text>
          )}
          <Button
            icon={RotateCcw}
            label={m.reservations_book_again({}, { locale })}
            onPress={() => router.push(rebookingHref)}
          />
        </>
      );
    case "RetryPayment":
      return retryPaymentAction;
    case "Withdrawn":
      return (
        <Text variant="bodySmall" tone="default">
          {m.withdrawal_ticket_note(
            { amount: formatMoney(stub.refundAmount, locale) },
            { locale }
          )}
        </Text>
      );
    case "Steps":
      return (
        <>
          <BookingSteps steps={ticketSteps(stub.steps, locale)} />
          {Option.match(stub.action, {
            onNone: () => null,
            onSome: (action) =>
              ({
                "check-again": (
                  <Button
                    icon={RotateCcw}
                    label={m.reservations_check_again({}, { locale })}
                    busy={checking}
                    onPress={onCheckAgain}
                  />
                ),
                contact: (
                  <Button
                    icon={Mail}
                    label={m.reservations_contact({}, { locale })}
                    onPress={() => openContactPage()}
                  />
                ),
                "payment-page": paymentPageAction,
              })[action],
          })}
        </>
      );
  }
}

function OrderTicket({
  state,
  onCheckAgain,
  onPaymentCheckAgain,
  onPaymentPageLeft,
  onTeamTableChanged,
  announce,
}: {
  readonly state: StatusRefreshState;
  readonly onCheckAgain: () => void;
  readonly onPaymentCheckAgain: () => void;
  /** The customer came back from the payment page: follow the payment. */
  readonly onPaymentPageLeft: () => void;
  readonly onTeamTableChanged: () => void;
  readonly announce: boolean;
}) {
  const locale = useAppLocale();
  const { order } = state;
  const reservation = useAtomValue(reservationOfOrderAtom(order.orderId));
  const row = Option.getOrUndefined(reservation);
  // Saved history strips party details. The endpoints authorize unknown viewers.
  const customerActionsAllowed =
    order.kind !== "table" || row?.party?.kind !== "booked-for";
  const booked =
    order.kind === "table" ? undefined : bookedSelectionOf(order, reservation);
  const tableSelection =
    order.kind === "table"
      ? teamTableSelectionOfReservation({
          product:
            order.product ??
            (row?.product.kind === "other" ? row.product.teamTable : undefined),
          startsAt: order.startsAt ?? row?.startsAt,
          endsAt: order.endsAt ?? row?.endsAt,
        })
      : undefined;
  const recovery = usePaymentRecovery(
    order,
    tableSelection === undefined ? booked : { selection: tableSelection },
    {
      onCheckAgain: onPaymentCheckAgain,
      onPaymentPageLeft,
    }
  );
  let rebookingHref: Href = bookAgainHref(booked);
  if (order.kind === "table") {
    rebookingHref =
      tableSelection === undefined
        ? bookFamilyHref("table")
        : teamTableBookAgainHref(tableSelection);
  }
  const model = orderTicketModel(
    order,
    orderCheckingOf(state.automatic),
    recovery.offer
  );
  const establishment = AsyncResult.value(useAtomValue(establishmentAtom));
  const view = orderTicketView({
    order,
    model,
    reservation,
    establishment,
    now: DateTime.nowUnsafe(),
    locale,
  });
  const withdrawn = model.stub._tag === "Withdrawn";
  const badge = ticketBadge(model.badge, locale);
  // The status changes while the screen is open: announce the new one.
  const statusAnnouncement =
    view.lead?.kind === "reason"
      ? `${badge.label}. ${view.lead.text}`
      : badge.label;
  useLiveRegionAnnouncement(
    announce ? statusAnnouncement : undefined,
    "polite"
  );
  // A payment action's answer, else the last read's own failure; a 429
  // reads as "temporarily limited".
  const failureMessage =
    recovery.notice ??
    Option.getOrUndefined(
      Option.map(
        state.failure,
        (failure) =>
          sharedViewErrorMessage(failure, locale) ??
          m.account_error_unexpected({}, { locale })
      )
    );
  return (
    <View style={styles.stack}>
      {/* Kept mounted so assistive tech announces each change. */}
      <Notice tone="warning" message={announce ? failureMessage : undefined} />
      <BookingTicket
        lead={view.lead}
        badge={badge}
        date={view.date}
        dateTone={model.dim ? "dim" : "strong"}
        badgePlacement={withdrawn ? "inline" : "header"}
        title={view.title}
        lines={view.lines}
        meta={view.meta}
      >
        <TicketStub
          model={model}
          order={order}
          rebookingHref={rebookingHref}
          accessAllowed={customerActionsAllowed}
          accessHint={view.accessHint}
          checking={state.reading}
          onCheckAgain={onCheckAgain}
          paymentPageAction={
            <Button
              label={m.booking_checkout_payment_reopen({}, { locale })}
              busy={recovery.reopening}
              disabled={recovery.busy}
              onPress={recovery.reopen}
            />
          }
          retryPaymentAction={
            <Button
              icon={RotateCcw}
              label={m.booking_checkout_retry_pay({}, { locale })}
              busy={recovery.retrying}
              disabled={recovery.busy}
              onPress={recovery.retry}
            />
          }
        />
      </BookingTicket>
      {order.people !== undefined && (
        <OrderPeopleSection
          order={order}
          people={order.people}
          refreshing={state.reading}
          onTeamTableChanged={onTeamTableChanged}
        />
      )}
      {model.followUp === "more-actions" && (
        <MoreActions
          order={order}
          invoiceAllowed={customerActionsAllowed}
          event={view.event}
          withdrawn={withdrawn}
          announce={announce}
        />
      )}
      {model.followUp === "contact" && <ContactLink />}
    </View>
  );
}

/** The order isn't the signed-in account's: say whose account this is. */
function OrderNotFound({ onReturn }: { readonly onReturn?: () => void }) {
  const locale = useAppLocale();
  const router = useRouter();
  const account = AsyncResult.value(useAtomValue(accountAtom));
  return (
    <Card>
      <EmptyState
        icon={Search}
        title={m.reservations_not_found_title({}, { locale })}
        body={Option.match(account, {
          onNone: () => m.reservations_order_not_found({}, { locale }),
          onSome: ({ email }) =>
            m.reservations_not_found_body({ email }, { locale }),
        })}
        live="polite"
      >
        <Button
          label={m.reservations_go_to_list({}, { locale })}
          onPress={onReturn ?? (() => router.dismissTo(reservationsHref))}
        />
        <Button
          variant="quiet"
          label={m.reservations_contact({}, { locale })}
          onPress={() => openContactPage()}
        />
      </EmptyState>
    </Card>
  );
}

/** The first read found no order the account may see. */
const isNotFound = <E extends CustomerRequestFailure>(
  result: AsyncResult.AsyncResult<unknown, E>
) =>
  AsyncResult.isFailure(result) &&
  Option.isNone(AsyncResult.value(result)) &&
  CustomerViewError.$is("NotFound")(viewErrorOf(result.cause));

export function ReservationPaneHeading({
  onBack,
  closes = false,
}: {
  readonly onBack?: () => void;
  readonly closes?: boolean;
}) {
  const locale = useAppLocale();
  const insets = useSafeAreaInsets();
  const column = useContentColumn("form");
  const title = closes
    ? m.reservations_your_booking({}, { locale })
    : m.reservations_status_title({}, { locale });
  return (
    <View style={[column, { paddingTop: insets.top + space.md }]}>
      <FocusedStatusBar style="dark" />
      {onBack === undefined ? (
        <Text variant="display" role="heading">
          {title}
        </Text>
      ) : (
        <AppBar
          title={title}
          onBack={onBack}
          back={closes ? "close" : "back"}
          alignToContent
        />
      )}
    </View>
  );
}

/**
 * An order as its booking ticket (GET status, which refreshes the order and
 * spends the read budget): where it stands, and the one thing to do next.
 * It keeps itself up to date while visible, focused, and in the foreground;
 * pulling down checks again once it has stopped checking on its own.
 */
export function OrderStatusScreen({
  orderId,
  visit,
  active = true,
  heading,
  onMissingReturn,
}: {
  readonly orderId: CustomerReservationOrderId;
  readonly visit: StatusVisit;
  readonly active?: boolean;
  readonly heading?: ReactNode;
  readonly onMissingReturn?: () => void;
}) {
  const locale = useAppLocale();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const registry = useContext(RegistryContext);
  const [owner] = useState(() => Symbol());
  const visible = useRef(active);
  const focusAtom = orderStatusAtoms.focus(orderId);
  const currentFocus = useAtomValue(focusAtom);
  const result = useAtomValue(orderStatusAtoms.status(orderId));
  const setFocus = useAtomSet(focusAtom);
  const tap = useAtomSet(orderStatusAtoms.refreshRequests(orderId));

  useLayoutEffect(() => {
    visible.current = active;
    setFocus(focusVisibility(owner, active));
  }, [active, owner, setFocus]);

  useFocusEffect(
    useCallback(() => {
      setFocus(focusGained(visit, owner, visible.current));
      return () => setFocus(focusLost(owner));
    }, [owner, setFocus, visit])
  );

  const ownsRefresh = () => {
    const focus = registry.get(focusAtom);
    return focus.owner === owner && focus.visible && navigation.isFocused();
  };
  const retryRead = () => {
    if (ownsRefresh()) setFocus(restartStatusVisit(owner));
  };
  // After a failed first read the refreshes have ended: start them again.
  const refresh = () => {
    if (ownsRefresh()) {
      if (AsyncResult.isFailure(result)) setFocus(restartStatusVisit(owner));
      else tap((taps) => taps + 1);
    }
  };
  const checkAfterPayment = () => {
    const focus = registry.get(focusAtom);
    if (focus.owner !== owner || !navigation.isFocused()) return;
    if (focus.visible) refresh();
    // A payment outcome can invalidate the order while its preview is hidden.
    // Start the fresh read once the same preview is visible.
    else setFocus(restartStatusVisit(owner));
  };
  const refreshable = Option.match(AsyncResult.value(result), {
    onNone: () => AsyncResult.isFailure(result),
    onSome: canRefreshManually,
  });

  // Automatic reads show in the steps; the pull indicator is for the reads
  // the customer asked for.
  const pulled = Option.match(AsyncResult.value(result), {
    onNone: () => result.waiting,
    onSome: (state) =>
      state.reading && AutomaticRefresh.$is("Stopped")(state.automatic),
  });
  const shown = AsyncResult.isSuccess(result)
    ? AsyncResult.success(result.value, { waiting: pulled })
    : result;

  return (
    <>
      {heading}
      <ScrollScreen
        refreshing={pulled && !AsyncResult.isInitial(result)}
        onRefresh={refreshable ? refresh : undefined}
      >
        {isNotFound(result) ? (
          <OrderNotFound onReturn={onMissingReturn} />
        ) : (
          <AsyncView
            result={shown}
            onRetry={retryRead}
            loading={
              <BookingTicketSkeleton
                label={m.account_loading({}, { locale })}
                stub="button"
              />
            }
          >
            {(state) => (
              <OrderTicket
                state={state}
                onCheckAgain={refresh}
                onPaymentCheckAgain={checkAfterPayment}
                onTeamTableChanged={retryRead}
                onPaymentPageLeft={() => {
                  if (!navigation.isFocused()) return;
                  setFocus(restartStatusVisit(owner, "after-payment"));
                }}
                announce={active && focused && currentFocus.owner === owner}
              />
            )}
          </AsyncView>
        )}
      </ScrollScreen>
    </>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  centred: { textAlign: "center" },
});
