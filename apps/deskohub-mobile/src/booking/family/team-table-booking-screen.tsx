import type {
  CustomerTeamTableOfferings,
  CustomerTeamTableSelection,
} from "@deskohub/workspace-customer-api";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import RotateCcw from "lucide-react-native/icons/rotate-ccw";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { ChoiceList } from "../../ui/choice-list";
import { Notice } from "../../ui/notice";
import { space } from "../../ui/tokens";
import { teamTablePreselectionOf } from "../booking-preselection";
import { bookCheckoutHref } from "../booking-routes";
import { checkoutRequestAtom } from "../checkout/checkout-flow";
import {
  bookingQuoteAtom,
  teamTableCalendarAtom,
  teamTableOfferingsAtom,
  teamTableSlotsAtom,
} from "../data/booking-queries";
import { selectionKey } from "../selection/booking-selection";
import { officePeopleCount } from "../selection/office-people";
import { pragueToday } from "../selection/prague-date";
import {
  isTeamTableDateAvailable,
  openingTeamTableDraft,
  teamTableDates,
  teamTableSelection,
} from "../selection/team-table-selection";
import { BookingBar } from "../ui/booking-bar";
import { BookingSectionHeading } from "../ui/booking-section-heading";
import { BookingStepLayout } from "../ui/booking-step-layout";
import { MonthCalendar } from "../ui/month-calendar";
import { bookingClockAtom } from "./booking-clock";
import { unneededReadAtom } from "./booking-family-atoms";
import { bookingQueryMessage } from "./booking-family-copy";
import { useBookingStarted, useRestartReason } from "./booking-family-hooks";
import {
  type BookingRead,
  bookingReadOf,
  checkoutRequestOf,
  freshValue,
  loadedValue,
  readValue,
  restartReasonOf,
} from "./booking-family-view";
import { BookingGate } from "./booking-gate";
import { BookingReadView } from "./booking-read-view";
import { chooseStyles, useChooseTracks } from "./choose-layout";
import { officeContactOf } from "./office-booking-model";
import { OfficePeopleList } from "./office-people-list";
import { RestartNotice } from "./restart-notice";
import { selectionBar } from "./selection-bar";
import {
  teamTableCapacities,
  teamTableCapacityLabel,
  teamTableRateLabel,
} from "./team-table-offerings";
import { TeamTableTimeField } from "./team-table-time-field";

export function TeamTableBookingScreen() {
  useBookingStarted("table");
  return (
    <View style={styles.screen}>
      <BookingGate>
        <TeamTableCatalog />
      </BookingGate>
    </View>
  );
}

function TeamTableCatalog() {
  const locale = useAppLocale();
  const offeringsAtom = teamTableOfferingsAtom(locale);
  const catalog = bookingReadOf(useAtomValue(offeringsAtom));
  const refresh = useAtomRefresh(offeringsAtom);
  const params = useLocalSearchParams();
  const preselection = Option.getOrUndefined(teamTablePreselectionOf(params));
  const value = Option.getOrUndefined(readValue(catalog));
  const capacities = teamTableCapacities(value?.offerings ?? []);
  const first = capacities[0];
  if (first !== undefined) {
    return (
      <TeamTableSelectionStep
        key={JSON.stringify(preselection ?? null)}
        catalog={catalog}
        refreshCatalog={refresh}
        capacities={capacities}
        initialOffering={first}
        preselection={preselection}
        restarting={Option.isSome(restartReasonOf(params.restart))}
      />
    );
  }
  return (
    <BookingStepLayout
      step="choose"
      locale={locale}
      bar={
        <BookingBar
          locale={locale}
          summary={{
            title: m.booking_checkout_line_team_table({}, { locale }),
            price: { kind: "none" },
          }}
          action={{
            label: m.booking_continue({}, { locale }),
            onPress: () => undefined,
            disabled: true,
          }}
        />
      }
    >
      <BookingReadView read={catalog} onRetry={refresh}>
        {() => (
          <Notice
            tone="warning"
            message={m.booking_team_table_unavailable({}, { locale })}
          />
        )}
      </BookingReadView>
    </BookingStepLayout>
  );
}

type TeamTableOffering = CustomerTeamTableOfferings["offerings"][number];

function TeamTableSelectionStep({
  catalog,
  refreshCatalog,
  capacities,
  initialOffering,
  preselection,
  restarting,
}: {
  readonly catalog: BookingRead<CustomerTeamTableOfferings>;
  readonly refreshCatalog: () => void;
  readonly capacities: ReadonlyArray<TeamTableOffering>;
  readonly initialOffering: TeamTableOffering;
  readonly preselection: CustomerTeamTableSelection | undefined;
  readonly restarting: boolean;
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const now = useAtomValue(bookingClockAtom);
  const request = useAtomValue(checkoutRequestAtom);
  const setCheckoutRequest = useAtomSet(checkoutRequestAtom);
  const contact = Option.flatMap(
    AsyncResult.value(useAtomValue(accountAtom)),
    officeContactOf
  );
  const [draft, setDraft] = useState(() => {
    const restart = restarting ? Option.getOrUndefined(request) : undefined;
    const restartedSelection =
      restart?.selection.family === "table" ? restart.selection : undefined;
    return openingTeamTableDraft(
      initialOffering.product.seats,
      preselection ?? restartedSelection,
      restartedSelection !== undefined && restart?._tag === "Booking"
        ? restart.people
        : undefined
    );
  });
  const offering = capacities.find(
    ({ product }) => product.seats === draft.seats
  );
  const calendarAtom =
    offering === undefined
      ? unneededReadAtom
      : teamTableCalendarAtom({ seats: draft.seats });
  const calendarRead = bookingReadOf(useAtomValue(calendarAtom));
  const refreshCalendar = useAtomRefresh(calendarAtom);
  const calendar = Option.getOrUndefined(loadedValue(calendarRead));
  const dates = teamTableDates(calendar, draft.seats);
  const today = pragueToday(now);
  const date = draft.date;
  const hasDateToCheck =
    offering !== undefined && date !== undefined && date >= today;
  const selectedSlotsAtom = hasDateToCheck
    ? teamTableSlotsAtom({ seats: draft.seats, date })
    : unneededReadAtom;
  const canReadSlots =
    hasDateToCheck &&
    dates !== undefined &&
    isTeamTableDateAvailable(date, dates);
  const slotsRead = bookingReadOf(
    useAtomValue(canReadSlots ? selectedSlotsAtom : unneededReadAtom)
  );
  const refreshSlots = useAtomRefresh(selectedSlotsAtom);
  const model = teamTableSelection(
    draft,
    calendar,
    Option.getOrUndefined(loadedValue(slotsRead)),
    now
  );
  const selection = Option.fromNullishOr(model.selection);
  const quoteKey = model.selection && selectionKey(model.selection);
  const [settledQuoteKey, setSettledQuoteKey] = useState<string>();
  const [refreshQuoteOnReady, setRefreshQuoteOnReady] = useState(restarting);
  const lastRejectedSlot = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (quoteKey === undefined) return;
    // Team Table quotes query live inventory and spend its read budget.
    const timer = setTimeout(() => setSettledQuoteKey(quoteKey), 250);
    return () => clearTimeout(timer);
  }, [quoteKey]);
  const availabilityIsFresh =
    Option.isSome(freshValue(catalog)) &&
    Option.isSome(freshValue(calendarRead)) &&
    Option.isSome(freshValue(slotsRead));
  const quoteAtom =
    !availabilityIsFresh ||
    model.selection === undefined ||
    quoteKey !== settledQuoteKey
      ? unneededReadAtom
      : bookingQuoteAtom(model.selection, locale);
  const quoteRead = bookingReadOf(useAtomValue(quoteAtom));
  const refreshQuote = useAtomRefresh(quoteAtom);
  const cachedQuote =
    (quoteRead.kind === "loaded" && !quoteRead.refreshing) ||
    (quoteRead.kind === "failed" && !quoteRead.retrying);
  useEffect(() => {
    if (!refreshQuoteOnReady || quoteAtom === unneededReadAtom) return;
    if (cachedQuote) refreshQuote();
    setRefreshQuoteOnReady(false);
  }, [cachedQuote, quoteAtom, refreshQuote, refreshQuoteOnReady]);
  const slotRejected =
    quoteRead.kind === "failed" && quoteRead.error._tag === "SlotUnavailable";
  useEffect(() => {
    if (
      quoteKey === undefined ||
      !slotRejected ||
      lastRejectedSlot.current === quoteKey
    )
      return;
    lastRejectedSlot.current = quoteKey;
    refreshSlots();
  }, [quoteKey, refreshSlots, slotRejected]);
  const quote = Option.map(selection, () => quoteRead);
  const checkout = checkoutRequestOf({
    locale,
    selection,
    blockers: [],
    quote: refreshQuoteOnReady ? Option.none() : freshValue(quoteRead),
    people: draft.people,
  });
  const name = initialOffering.name;
  const tracks = useChooseTracks(2);
  const sizeLabel = m.booking_team_table_size({}, { locale });
  const dateLabel = m.booking_date_heading({}, { locale });
  const checkingTimes =
    model.starts.length > 0 && model.selection === undefined;
  let reason: string | undefined;
  if (!model.hasAttendee) {
    reason = m.booking_team_table_attendee_required({}, { locale });
  } else if (!model.withinCapacity) {
    reason = m.booking_team_table_people_over_capacity({}, { locale });
  } else if (checkingTimes) {
    reason = m.booking_team_table_times_unavailable({}, { locale });
  }
  const bar = selectionBar({
    from: { title: name },
    selection,
    quote,
    blocked: Option.fromNullishOr(reason),
    canContinue: Option.isSome(checkout),
    locale,
  });

  return (
    <BookingStepLayout
      step="choose"
      locale={locale}
      bar={
        <BookingBar
          locale={locale}
          summary={bar.summary}
          reason={bar.reason}
          action={
            bar.action === "retry"
              ? {
                  label: m.booking_checkout_retry({}, { locale }),
                  icon: RotateCcw,
                  onPress: refreshQuote,
                  disabled: bar.disabled,
                }
              : {
                  label: m.booking_continue({}, { locale }),
                  onPress: () =>
                    Option.map(checkout, (value) => {
                      setCheckoutRequest(Option.some(value));
                      router.push(bookCheckoutHref);
                    }),
                  disabled: bar.disabled,
                }
          }
        />
      }
    >
      <Stack.Screen options={{ title: name }} />
      <TeamTableRestartNotice
        onReread={() => {
          refreshCatalog();
          refreshCalendar();
          refreshSlots();
          lastRejectedSlot.current = undefined;
          setRefreshQuoteOnReady(true);
        }}
      />
      <Notice
        tone="error"
        message={
          Option.isSome(selection) && quoteRead.kind === "failed"
            ? bookingQueryMessage(quoteRead.error, locale)
            : undefined
        }
      />
      <BookingReadView
        read={catalog}
        onRetry={refreshCatalog}
        retryOnRefreshFailure
      >
        {() => (
          <>
            <BookingSectionHeading first title={sizeLabel} />
            <ChoiceList
              label={sizeLabel}
              choices={capacities.map((capacity) => ({
                value: String(capacity.product.seats),
                label: teamTableCapacityLabel(capacity.product.seats, locale),
                description: teamTableRateLabel(capacity, locale),
              }))}
              selected={String(draft.seats)}
              onSelect={(value) => {
                const seats = Number(value);
                setDraft((previous) =>
                  seats === previous.seats
                    ? previous
                    : {
                        ...previous,
                        seats,
                        startTime: undefined,
                        endTime: undefined,
                      }
                );
              }}
            />
            {offering === undefined ? (
              <Notice
                tone="warning"
                message={m.booking_error_offering_unavailable({}, { locale })}
              />
            ) : (
              <View style={tracks && chooseStyles.row}>
                <View style={tracks && chooseStyles.calendar}>
                  <BookingSectionHeading title={dateLabel} />
                  <BookingReadView
                    read={calendarRead}
                    onRetry={refreshCalendar}
                    retryOnRefreshFailure
                  >
                    {() =>
                      dates !== undefined && (
                        <>
                          <MonthCalendar
                            stretch={tracks}
                            label={dateLabel}
                            locale={locale}
                            dates={
                              dates.earliest >= today
                                ? dates
                                : { ...dates, earliest: today }
                            }
                            today={today}
                            selected={date}
                            onSelect={(nextDate) =>
                              setDraft((previous) =>
                                previous.date === nextDate
                                  ? previous
                                  : {
                                      ...previous,
                                      date: nextDate,
                                      startTime: undefined,
                                      endTime: undefined,
                                    }
                              )
                            }
                            previousMonthLabel={m.booking_calendar_previous_month(
                              {},
                              { locale }
                            )}
                            nextMonthLabel={m.booking_calendar_next_month(
                              {},
                              { locale }
                            )}
                            unavailableLabel={m.booking_calendar_unavailable_day(
                              {},
                              { locale }
                            )}
                          />
                          {date !== undefined && !canReadSlots && (
                            <Notice
                              tone="warning"
                              message={m.booking_team_table_date_unavailable(
                                {},
                                { locale }
                              )}
                            />
                          )}
                        </>
                      )
                    }
                  </BookingReadView>
                </View>
                <View style={[styles.details, tracks && chooseStyles.track]}>
                  {canReadSlots && (
                    <BookingReadView
                      read={slotsRead}
                      onRetry={refreshSlots}
                      retryOnRefreshFailure
                    >
                      {() =>
                        model.starts.length === 0 ? (
                          <Notice
                            tone="warning"
                            message={m.booking_team_table_no_times(
                              {},
                              { locale }
                            )}
                          />
                        ) : (
                          <View style={styles.times}>
                            <TeamTableTimeField
                              key={`start:${draft.seats}:${date}`}
                              label={m.booking_team_table_start({}, { locale })}
                              locale={locale}
                              times={model.starts}
                              selected={draft.startTime}
                              onSelect={(startTime) =>
                                setDraft((previous) =>
                                  previous.startTime === startTime
                                    ? previous
                                    : {
                                        ...previous,
                                        startTime,
                                        endTime: undefined,
                                      }
                                )
                              }
                            />
                            <TeamTableTimeField
                              key={`end:${draft.seats}:${date}:${draft.startTime}`}
                              label={m.booking_team_table_end({}, { locale })}
                              locale={locale}
                              times={model.ends}
                              startTime={draft.startTime}
                              selected={draft.endTime}
                              onSelect={(endTime) =>
                                setDraft((previous) => ({
                                  ...previous,
                                  endTime,
                                }))
                              }
                            />
                          </View>
                        )
                      }
                    </BookingReadView>
                  )}
                  <BookingSectionHeading
                    title={m.booking_office_people_heading({}, { locale })}
                    aside={m.booking_office_people_of(
                      {
                        count: officePeopleCount(draft.people),
                        maximum: draft.seats,
                      },
                      { locale }
                    )}
                  />
                  <OfficePeopleList
                    contact={contact}
                    locale={locale}
                    people={draft.people}
                    maximumSeats={Option.some(draft.seats)}
                    fullMessage={
                      model.withinCapacity
                        ? m.reservations_table_invitee_capacity({}, { locale })
                        : m.booking_team_table_people_over_capacity(
                            {},
                            { locale }
                          )
                    }
                    showPinNote={false}
                    minimumAttendees={0}
                    onChange={(people) =>
                      setDraft((previous) => ({ ...previous, people }))
                    }
                  />
                </View>
              </View>
            )}
          </>
        )}
      </BookingReadView>
    </BookingStepLayout>
  );
}

function TeamTableRestartNotice({
  onReread,
}: {
  readonly onReread: () => void;
}) {
  return (
    <RestartNotice
      reason={useRestartReason(onReread, { refreshOnOpen: true })}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  details: { paddingTop: space.lg },
  times: { gap: space.md },
});
