import type {
  CustomerBookedSelection,
  CustomerOffering,
} from "@deskohub/workspace-customer-api";
import { CustomerPassId } from "@deskohub/workspace-customer-api";
import {
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { type Array as Arr, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useLocalSearchParams, useRoute, useRouter } from "expo-router";
import Coffee from "lucide-react-native/icons/coffee";
import Monitor from "lucide-react-native/icons/monitor";
import RotateCcw from "lucide-react-native/icons/rotate-ccw";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { AppLocale } from "../../i18n/app-locale";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";
import { EntryPackBanner } from "../../passes/entry-pack-banner";
import {
  coworkPassTier,
  entryPackDates,
  fundWithEntryPack,
  openEntryPackDraft,
  packCoversDraft,
} from "../../passes/entry-pack-booking";
import { PassOfferCards } from "../../passes/pass-offer-cards";
import {
  coworkPassOfferCatalog,
  holdsCurrentUnlimitedPass,
} from "../../passes/pass-offers";
import { cashBookingCoverage } from "../../passes/pass-read-state";
import {
  heldPassesAtom,
  passBookingOptionsAtom,
  passCatalogAtom,
} from "../../passes/pass-reads";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Button } from "../../ui/controls";
import { Notice } from "../../ui/notice";
import { Skeleton, SkeletonGroup } from "../../ui/skeleton";
import { color, radius, space } from "../../ui/tokens";
import { bookingPreselectionKey } from "../booking-preselection";
import { bookCheckoutHref } from "../booking-routes";
import { checkoutRequestAtom } from "../checkout/checkout-flow";
import {
  bookingAvailabilityAtom,
  bookingOfferingsAtom,
  bookingQuoteAtom,
} from "../data/booking-queries";
import {
  type CoworkBlocker,
  type CoworkDraft,
  type CoworkOffering,
  coworkAvailabilityQueries,
  coworkBookableDates,
  coworkDayQuery,
  freeCoworkTierOn,
  offeredCoworkTiers,
  selectCoworkDate,
  selectCoworkStay,
  selectCoworkTier,
  selectCoworkWorkstation,
} from "../selection/cowork-selection";
import type { PragueDate } from "../selection/prague-date";
import { pragueToday } from "../selection/prague-date";
import { AddonOptions, AddonToggle } from "../ui/addon-toggle";
import { BookingBar } from "../ui/booking-bar";
import { BookingSectionHeading } from "../ui/booking-section-heading";
import { BookingStepLayout } from "../ui/booking-step-layout";
import { MonthCalendar } from "../ui/month-calendar";
import {
  formatPragueDate,
  formatShortPragueDate,
} from "../ui/prague-date-format";
import { bookingClockAtom } from "./booking-clock";
import { unneededReadAtom } from "./booking-family-atoms";
import {
  availabilityNoticeMessage,
  bookingQueryMessage,
} from "./booking-family-copy";
import {
  useBookingPreselection,
  useBookingStarted,
  useRestartReason,
} from "./booking-family-hooks";
import {
  type BookingRead,
  bookingReadOf,
  checkoutRequestOf,
  freshValue,
  loadedValue,
  quoteFailureRepeats,
  readValue,
  restartReasonOf,
} from "./booking-family-view";
import { BookingGate } from "./booking-gate";
import { BookingReadFailure, BookingReadView } from "./booking-read-view";
import {
  chooseStyles,
  useChooseTracks,
  useCoworkTierPair,
} from "./choose-layout";
import {
  coworkBookingModel,
  type KeptCoworkDraft,
  keptCoworkEntryChoice,
  openingCoworkDraft,
} from "./cowork-booking-model";
import { CoworkDateHeading, CoworkStayTimes } from "./cowork-stay";
import {
  type CoworkTierCard,
  CoworkTierCards,
  tierArtwork,
} from "./cowork-tier-cards";
import { RestartNotice } from "./restart-notice";
import { selectionBar } from "./selection-bar";

/**
 * The customer's cowork draft, with the preselection it grew from; none
 * until they change what the screen opened with.
 */
const decodePassId = Schema.decodeUnknownOption(CustomerPassId);

const coworkDraftAtom = Atom.make(Option.none<KeptCoworkDraft>());

const blockerMessage = (blocker: CoworkBlocker, locale: AppLocale) =>
  ({
    DateRequired: () => m.booking_choose_date_reason({}, { locale }),
    AvailabilityPending: () => undefined,
    DateOutOfRange: () => m.booking_error_date_out_of_range({}, { locale }),
    OpenSpaceClosedToday: () =>
      m.booking_cowork_open_space_closed_today({}, { locale }),
    OfferUnavailable: () => m.booking_cowork_offer_unavailable({}, { locale }),
    WorkstationUnavailable: () =>
      m.booking_cowork_workstation_unavailable({}, { locale }),
    WorkstationRequired: () =>
      m.booking_cowork_workstation_required({}, { locale }),
  })[blocker._tag]();

/**
 * Cowork: an Open Space or Reserved Desk day with its extras, opened empty
 * or on a booked selection ("Book again").
 */
export function CoworkBookingScreen() {
  useBookingStarted("cowork");
  const preselection = useBookingPreselection("cowork");
  return (
    <View style={styles.screen}>
      <BookingGate>
        <CoworkCatalog preselection={preselection} />
      </BookingGate>
    </View>
  );
}

function CoworkCatalog({
  preselection,
}: {
  readonly preselection: Option.Option<CustomerBookedSelection>;
}) {
  const locale = useAppLocale();
  const catalogAtom = bookingOfferingsAtom(locale);
  const read = bookingReadOf(useAtomValue(catalogAtom));
  const refresh = useAtomRefresh(catalogAtom);
  const catalog = readValue(read);
  const tiers = Option.flatMap(catalog, ({ offerings }) =>
    offeredCoworkTiers(offerings)
  );
  if (Option.isSome(catalog) && Option.isSome(tiers)) {
    return (
      <CoworkSelection
        offerings={catalog.value.offerings}
        tiers={tiers.value}
        catalog={read}
        onRetryCatalog={refresh}
        preselection={preselection}
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
            title: m.booking_family_cowork_title({}, { locale }),
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
      <BookingReadView
        read={read}
        onRetry={refresh}
        loading={<CoworkSkeleton locale={locale} />}
      >
        {() => null}
      </BookingReadView>
    </BookingStepLayout>
  );
}

function CoworkSelection({
  offerings,
  tiers,
  catalog,
  onRetryCatalog,
  preselection,
}: {
  readonly offerings: ReadonlyArray<CustomerOffering>;
  /** The cowork offerings, one per tier; never empty. */
  readonly tiers: Arr.NonEmptyReadonlyArray<CoworkOffering>;
  readonly catalog: BookingRead<unknown>;
  readonly onRetryCatalog: () => void;
  readonly preselection: Option.Option<CustomerBookedSelection>;
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const setCheckoutRequest = useAtomSet(checkoutRequestAtom);
  const now = useAtomValue(bookingClockAtom);
  const today = pragueToday(now);

  const { key: routeKey } = useRoute();
  const { passId: passParam, restart: restartParam } = useLocalSearchParams<{
    passId?: string;
    restart?: string;
  }>();
  const restart = restartReasonOf(restartParam);
  const linkedPassId =
    passParam === undefined
      ? undefined
      : Option.getOrElse(decodePassId(passParam), () => "invalid-pass");
  const seed = linkedPassId ?? bookingPreselectionKey(preselection);
  const [kept, setStored] = useAtom(coworkDraftAtom);
  const keptForRoute = Option.getOrUndefined(
    keptCoworkEntryChoice(
      kept,
      seed,
      routeKey,
      linkedPassId === undefined && Option.isSome(restart)
    )
  );
  const entryPackId =
    keptForRoute === undefined ? linkedPassId : keptForRoute.entryPackId;

  const passCatalog = useAtomValue(passCatalogAtom);
  const passListAtom = heldPassesAtom(locale);
  const passList = useAtomValue(passListAtom);
  const refreshPassList = useAtomRefresh(passListAtom);
  const waitingForLinkedPack =
    linkedPassId !== undefined &&
    keptForRoute === undefined &&
    AsyncResult.isInitial(passList);
  const held = AsyncResult.isSuccess(passList) ? passList.value.held : [];
  const packs = held.filter((pass) => pass.kind === "entry-pack");
  const offerCatalog = coworkPassOfferCatalog({
    appliedPackId: entryPackId,
    catalog: passCatalog,
    heldPasses: passList,
  });
  const hasUnlimited = holdsCurrentUnlimitedPass(held);
  const refreshPassCatalog = useAtomRefresh(passCatalogAtom);
  const activePack = packs.find(({ passId }) => passId === entryPackId);
  const openingDraft = openingCoworkDraft({
    kept:
      entryPackId === linkedPassId && linkedPassId !== undefined
        ? Option.fromNullishOr(keptForRoute)
        : kept,
    preselection,
    offerings,
  });
  const draft =
    keptForRoute === undefined &&
    linkedPassId !== undefined &&
    activePack !== undefined
      ? openEntryPackDraft(openingDraft, activePack)
      : openingDraft;
  const storeDraft = (next: CoworkDraft, fundingId: string | undefined) =>
    setStored(
      Option.some({
        seed,
        routeKey,
        draft: next,
        ...(fundingId && { entryPackId: fundingId }),
      })
    );
  const setDraft = (next: CoworkDraft) => storeDraft(next, entryPackId);
  const [cardChoice, setCardChoice] = useState<CoworkDraft>();
  const choose = (next: CoworkDraft, covered: boolean) => {
    if (entryPackId !== undefined && !covered) setCardChoice(next);
    else setDraft(next);
  };

  const bookableDates = coworkBookableDates(tiers, draft.tier);
  const queries = coworkAvailabilityQueries(draft, bookableDates);
  const rangeAtom = bookingAvailabilityAtom({ query: queries.range });
  const selectionAtom = Option.match(queries.selection, {
    onNone: () => unneededReadAtom,
    onSome: (query) => bookingAvailabilityAtom({ query }),
  });
  const requirementAtom = Option.match(queries.workstationRequirement, {
    onNone: () => unneededReadAtom,
    onSome: (query) => bookingAvailabilityAtom({ query }),
  });
  const range = bookingReadOf(useAtomValue(rangeAtom));
  const selected = bookingReadOf(useAtomValue(selectionAtom));
  const requirement = bookingReadOf(useAtomValue(requirementAtom));
  const refreshRange = useAtomRefresh(rangeAtom);
  const refreshSelected = useAtomRefresh(selectionAtom);
  const refreshRequirement = useAtomRefresh(requirementAtom);

  const model = coworkBookingModel({
    draft,
    now,
    offerings,
    bookableDates,
    availability: {
      range: readValue(range),
      selection: Option.flatMap(queries.selection, () => loadedValue(selected)),
      workstationRequirement: Option.flatMap(
        queries.workstationRequirement,
        () => loadedValue(requirement)
      ),
    },
  });
  const { enablement } = model;

  // Keep the workstation the availability fitted, so the next reads are for it.
  useEffect(() => {
    if (!waitingForLinkedPack && model.draft !== draft) {
      setStored(
        Option.some({
          seed,
          routeKey,
          draft: model.draft,
          ...(entryPackId && { entryPackId }),
        })
      );
    }
  }, [
    model.draft,
    draft,
    seed,
    routeKey,
    setStored,
    entryPackId,
    waitingForLinkedPack,
  ]);

  const chosenDate = Option.getOrUndefined(model.draft.date);
  const chosenWorkstation = Option.getOrUndefined(model.draft.workstation);
  const optionsAtom =
    chosenDate !== undefined &&
    (packs.some(({ bookFrom }) => bookFrom !== undefined) ||
      hasUnlimited ||
      entryPackId !== undefined)
      ? passBookingOptionsAtom({
          date: chosenDate,
          tier: model.draft.tier,
          ...(chosenWorkstation && { monitorOption: chosenWorkstation.option }),
          ...(model.draft.stay === "overnight" && { stay: model.draft.stay }),
        })
      : unneededReadAtom;
  const optionsResult = useAtomValue(optionsAtom);
  const refreshPassOptions = useAtomRefresh(optionsAtom);
  const options = AsyncResult.isSuccess(optionsResult)
    ? optionsResult.value
    : undefined;
  const allowedByOptions = new Set(
    options?.entryPacks.map(({ passId }) => passId)
  );
  const requiredWorkstationOffer =
    enablement.workstationRequired && options !== undefined
      ? packs.find(
          (pack) =>
            pack.tier === "reserved-desk" && allowedByOptions.has(pack.passId)
        )
      : undefined;
  const coverage =
    entryPackId === undefined && chosenDate !== undefined
      ? cashBookingCoverage(
          passCatalog,
          passList,
          optionsResult,
          coworkPassTier(model.draft)
        )
      : "clear";
  const retryPassReads = () => {
    refreshPassCatalog();
    refreshPassList();
    refreshPassOptions();
  };
  const offer =
    chosenDate === undefined
      ? packs
          .filter(
            (pack) =>
              pack.bookFrom !== undefined && packCoversDraft(pack, model.draft)
          )
          .reduce<(typeof packs)[number] | undefined>(
            (first, pack) =>
              first === undefined || pack.lastUsableDate < first.lastUsableDate
                ? pack
                : first,
            undefined
          )
      : (packs.find(({ passId }) => passId === options?.suggestedPackId) ??
        requiredWorkstationOffer);
  const packPending =
    entryPackId !== undefined &&
    (AsyncResult.isInitial(passList) ||
      (chosenDate !== undefined &&
        activePack !== undefined &&
        AsyncResult.isInitial(optionsResult)));
  const awaitingMonitor =
    activePack?.tier === "reserved-desk-workstation" &&
    chosenWorkstation === undefined;
  const packUnavailable =
    entryPackId !== undefined &&
    !packPending &&
    (activePack?.bookFrom === undefined ||
      (chosenDate !== undefined &&
        options !== undefined &&
        (!allowedByOptions.has(entryPackId) ||
          (!awaitingMonitor &&
            !packCoversDraft(
              activePack,
              model.draft,
              enablement.workstationRequired
            )))) ||
      (chosenDate !== undefined && AsyncResult.isFailure(optionsResult)));
  const selectedBooking = fundWithEntryPack(model.selection, entryPackId);
  const quotable =
    packPending || packUnavailable || awaitingMonitor
      ? Option.none()
      : fundWithEntryPack(model.quotable, entryPackId);
  const quoteAtom = Option.match(quotable, {
    onNone: () => unneededReadAtom,
    onSome: (selection) => bookingQuoteAtom(selection, locale),
  });
  const quoteResult = useAtomValue(quoteAtom);
  const refreshQuote = useAtomRefresh(quoteAtom);
  const quote = Option.map(quotable, () => bookingReadOf(quoteResult));

  // A full day the customer tapped, explained for the tier it is full for.
  const [tapped, setTapped] = useState<{
    readonly date: PragueDate;
    readonly tier: CoworkDraft["tier"];
  }>();
  const focusedDay = tapped?.tier === draft.tier ? tapped.date : undefined;
  const dayAtom =
    focusedDay === undefined
      ? unneededReadAtom
      : bookingAvailabilityAtom({
          query: coworkDayQuery(draft)(focusedDay),
        });
  const day = loadedValue(bookingReadOf(useAtomValue(dayAtom)));

  const rereadAvailability = () => {
    refreshRange();
    refreshSelected();
    refreshRequirement();
  };
  const supportingReads = [range, selected, requirement];
  const quoteRepeats = quoteFailureRepeats(quote, supportingReads, (error) =>
    bookingQueryMessage(error, locale)
  );
  const retrySupportingReads = () => {
    rereadAvailability();
    if (quoteRepeats) refreshQuote();
  };

  const chosen = tiers.find(({ tier }) => tier === model.draft.tier);
  const tracks = useChooseTracks(3);
  const tierPair = useCoworkTierPair(tracks);
  const shortDate = (date: PragueDate) => formatShortPragueDate(date, locale);
  const blocked = enablement.blockers.flatMap((blocker) => {
    const message = blockerMessage(blocker, locale);
    return message === undefined ? [] : [message];
  });
  const overnightStay = Option.getOrUndefined(model.overnightStay);
  // The stay's times, for summaries of an overnight selection.
  const overnightTimes =
    overnightStay !== undefined && model.draft.stay === "overnight"
      ? { overnightStay }
      : {};
  const checkout = checkoutRequestOf({
    locale,
    selection: selectedBooking,
    blockers:
      coverage === "checking" || coverage === "unknown"
        ? [...enablement.blockers, "pass-coverage"]
        : enablement.blockers,
    quote: Option.flatMap(quote, freshValue),
    ...overnightTimes,
  });
  const failedQuote = Option.getOrUndefined(quote);
  const quoteFailure =
    failedQuote?.kind === "failed" && !quoteRepeats ? failedQuote : undefined;

  const bar =
    chosen === undefined
      ? undefined
      : selectionBar({
          from: {
            title: chosen.name,
            amount: chosen.advertisedPrice.price,
            ...(model.draft.stay === "overnight" && {
              unit: m.booking_price_unit_per_night({}, { locale }),
            }),
            ...overnightTimes,
          },
          selection: selectedBooking,
          quote,
          blocked: Option.fromNullishOr(blocked[0]),
          ...(coverage === "covered" && {
            readyNotice: m.booking_pass_unlimited_covers({}, { locale }),
          }),
          canContinue: Option.isSome(checkout),
          locale,
        });

  const claimedDates = packs.flatMap(({ bookedDates }) => bookedDates);
  const cards = tiers.map(
    (offering): CoworkTierCard => ({
      tier: offering.tier,
      name: offering.name,
      price: offering.advertisedPrice.price,
      ...(activePack !== undefined &&
        offering.tier === model.draft.tier && {
          entryPrice: m.booking_pass_one_entry({}, { locale }),
        }),
      ...(offering.advertisedPrice.discount.value > 0 && {
        was: offering.price,
      }),
      description: [
        offering.summary ?? offering.usage,
        ...(offering.tier === "open-space"
          ? [m.booking_cowork_open_space_etiquette({}, { locale })]
          : []),
      ].join(" "),
      artwork: tierArtwork(
        offering.tier,
        offering.tier === model.draft.tier &&
          Option.isSome(model.draft.workstation)
      ),
      ...(chosenDate !== undefined &&
        enablement.unavailableTiers.has(offering.tier) && {
          unavailable: m.booking_cowork_tier_full(
            { date: shortDate(chosenDate) },
            { locale }
          ),
        }),
    })
  );

  const fullDayInfo =
    focusedDay === undefined || chosen === undefined
      ? undefined
      : Option.match(day, {
          onNone: () =>
            m.booking_cowork_day_full(
              { date: shortDate(focusedDay), tier: chosen.name },
              { locale }
            ),
          onSome: (availability) =>
            Option.match(
              freeCoworkTierOn(availability, offerings, chosen.tier),
              {
                onNone: () =>
                  m.booking_cowork_day_full_pick_another(
                    { date: shortDate(focusedDay), tier: chosen.name },
                    { locale }
                  ),
                onSome: (other) =>
                  m.booking_cowork_day_full_other_free(
                    {
                      date: shortDate(focusedDay),
                      tier: chosen.name,
                      other: other.name,
                    },
                    { locale }
                  ),
              }
            ),
        });

  const coffee =
    model.draft.tier === "open-space"
      ? chosen?.addOns.find(({ id, included }) => id === "coffee" && !included)
      : undefined;
  const workstation =
    model.draft.tier === "reserved-desk" && enablement.workstations.length > 0
      ? chosen?.addOns.find(({ id }) => id === "workstation")
      : undefined;
  const firstFreeWorkstation = enablement.workstations.find(
    ({ id }) => !enablement.unavailableWorkstations.has(id)
  );

  if (waitingForLinkedPack) {
    return (
      <BookingStepLayout step="choose" locale={locale} bar={undefined}>
        <CoworkSkeleton locale={locale} />
      </BookingStepLayout>
    );
  }

  return (
    <BookingStepLayout
      step="choose"
      locale={locale}
      bar={
        bar && (
          <BookingBar
            locale={locale}
            summary={
              bar.summary === undefined || entryPackId === undefined
                ? bar.summary
                : {
                    ...bar.summary,
                    detail: m.booking_pass_entry_summary({}, { locale }),
                    ...(Option.isNone(Option.flatMap(quote, freshValue)) && {
                      price: { kind: "none" as const },
                    }),
                  }
            }
            action={
              bar.action === "retry" || coverage === "unknown"
                ? {
                    label: m.booking_checkout_retry({}, { locale }),
                    icon: RotateCcw,
                    onPress:
                      coverage === "unknown" ? retryPassReads : refreshQuote,
                    disabled: coverage !== "unknown" && bar.disabled,
                  }
                : {
                    label: m.booking_continue({}, { locale }),
                    disabled: bar.disabled,
                    onPress: () =>
                      Option.map(checkout, (request) => {
                        setCheckoutRequest(Option.some(request));
                        router.push(bookCheckoutHref);
                      }),
                  }
            }
            reason={
              bar.reason ??
              {
                clear: undefined,
                checking: m.account_loading({}, { locale }),
                unknown: m.passes_load_failed({}, { locale }),
                covered: undefined,
              }[coverage]
            }
            reasonTone={
              coverage === "unknown" && bar.reason === undefined
                ? "error"
                : "info"
            }
          />
        )
      }
    >
      <BookingReadView read={catalog} onRetry={onRetryCatalog}>
        {() => (
          <>
            <CoworkRestartNotice
              onReread={() => {
                rereadAvailability();
                refreshQuote();
              }}
            />
            <Notice
              tone="error"
              title={
                quoteFailure === undefined
                  ? undefined
                  : m.booking_quote_failed_title({}, { locale })
              }
              message={
                quoteFailure === undefined
                  ? undefined
                  : bookingQueryMessage(quoteFailure.error, locale)
              }
            />
            <BookingReadFailure
              reads={supportingReads}
              onRetry={retrySupportingReads}
            />

            <ConfirmDialog
              visible={cardChoice !== undefined}
              title={m.booking_pass_confirm_title({}, { locale })}
              body={m.booking_pass_confirm_body({}, { locale })}
              confirmLabel={m.booking_pass_pay_card({}, { locale })}
              cancelLabel={m.booking_pass_keep({}, { locale })}
              onConfirm={() => {
                if (cardChoice !== undefined) storeDraft(cardChoice, undefined);
                setCardChoice(undefined);
              }}
              onCancel={() => setCardChoice(undefined)}
            />
            {(entryPackId !== undefined || offer !== undefined) && (
              <EntryPackBanner
                pack={entryPackId !== undefined ? activePack : offer}
                applied={entryPackId !== undefined}
                onApply={() => {
                  if (offer !== undefined)
                    storeDraft(model.draft, offer.passId);
                }}
                onPayByCard={() => storeDraft(model.draft, undefined)}
              />
            )}
            {packUnavailable && (
              <Notice
                tone="error"
                message={m.booking_pass_unavailable({}, { locale })}
              />
            )}
            {packUnavailable &&
              (AsyncResult.isFailure(passList) ||
                AsyncResult.isFailure(optionsResult)) && (
                <Button
                  variant="text"
                  label={m.account_retry({}, { locale })}
                  onPress={retryPassReads}
                />
              )}
            <View style={tracks && chooseStyles.row}>
              <View style={tracks && chooseStyles.track}>
                <BookingSectionHeading
                  title={m.booking_cowork_tier_heading({}, { locale })}
                  first
                />
                <CoworkTierCards
                  label={m.booking_cowork_tier_heading({}, { locale })}
                  cards={cards}
                  paired={tierPair}
                  stretch={tracks}
                  selected={model.draft.tier}
                  onSelect={(tier) => {
                    setTapped(undefined);
                    choose(
                      selectCoworkTier(model.draft, tier),
                      model.draft.tier === tier
                    );
                  }}
                  locale={locale}
                />
              </View>
              <View style={tracks && chooseStyles.calendar}>
                <CoworkDateHeading
                  first={tracks}
                  locale={locale}
                  overnightStay={overnightStay}
                  stay={model.draft.stay}
                  onStayChange={(stay) => {
                    setTapped(undefined);
                    setDraft(selectCoworkStay(model.draft, stay));
                  }}
                />
                <MonthCalendar
                  stretch={tracks}
                  label={m.booking_date_heading({}, { locale })}
                  locale={locale}
                  dates={
                    activePack === undefined
                      ? enablement.dates
                      : entryPackDates(
                          enablement.dates,
                          activePack,
                          claimedDates
                        )
                  }
                  selected={chosenDate}
                  onSelect={(date) => {
                    setTapped(undefined);
                    setDraft(selectCoworkDate(model.draft, date));
                  }}
                  today={today}
                  focusedDate={focusedDay}
                  onUnavailablePress={(date) => {
                    if (
                      activePack === undefined ||
                      !claimedDates.includes(date)
                    ) {
                      setTapped({ date, tier: model.draft.tier });
                    }
                  }}
                  dayInfo={fullDayInfo}
                  previousMonthLabel={m.booking_calendar_previous_month(
                    {},
                    { locale }
                  )}
                  nextMonthLabel={m.booking_calendar_next_month({}, { locale })}
                  unavailableLabel={m.booking_calendar_unavailable_day(
                    {},
                    { locale }
                  )}
                />
                <CoworkStayTimes
                  locale={locale}
                  overnightStay={overnightStay}
                  selection={model.selection}
                />
                <View style={styles.after}>
                  <Notice
                    tone="info"
                    message={
                      [
                        ...enablement.notices.map((notice) =>
                          availabilityNoticeMessage(notice, locale)
                        ),
                        ...(activePack === undefined
                          ? []
                          : [
                              m.booking_pass_date_rules(
                                {
                                  date: formatPragueDate(
                                    activePack.lastUsableDate,
                                    locale,
                                    {
                                      day: "numeric",
                                      month: "short",
                                      year: "numeric",
                                    }
                                  ),
                                },
                                { locale }
                              ),
                              ...(activePack.bookedDates[0] === undefined
                                ? []
                                : [
                                    m.booking_pass_already_booked(
                                      {
                                        date: shortDate(
                                          activePack.bookedDates[0]
                                        ),
                                      },
                                      { locale }
                                    ),
                                  ]),
                              m.booking_pass_final_dates({}, { locale }),
                            ]),
                      ].join(" ") || undefined
                    }
                  />
                </View>
              </View>
              {(coffee !== undefined || workstation !== undefined) && (
                <View style={tracks && chooseStyles.track}>
                  {coffee !== undefined && (
                    <>
                      <BookingSectionHeading
                        title={coffee.name}
                        first={tracks}
                      />
                      <AddonToggle
                        label={coffee.name}
                        icon={Coffee}
                        checked={model.draft.coffee}
                        onToggle={(checked) =>
                          setDraft({ ...model.draft, coffee: checked })
                        }
                        price={m.booking_addon_price(
                          { price: formatMoney(coffee.price, locale) },
                          { locale }
                        )}
                      />
                    </>
                  )}

                  {workstation !== undefined && (
                    <>
                      <BookingSectionHeading
                        title={workstation.name}
                        first={tracks && coffee === undefined}
                      />
                      <AddonToggle
                        label={workstation.name}
                        icon={Monitor}
                        checked={chosenWorkstation !== undefined}
                        disabled={enablement.workstationRequired}
                        onToggle={(checked) =>
                          choose(
                            selectCoworkWorkstation(
                              model.draft,
                              checked
                                ? Option.fromNullishOr(firstFreeWorkstation?.id)
                                : Option.none()
                            ),
                            activePack?.tier === "reserved-desk-workstation" &&
                              checked
                          )
                        }
                        price={m.booking_addon_price(
                          { price: formatMoney(workstation.price, locale) },
                          { locale }
                        )}
                      />
                      {chosenWorkstation !== undefined && (
                        <AddonOptions
                          label={workstation.name}
                          options={enablement.workstations.map(
                            ({ id, name }) => ({
                              value: id,
                              label: name,
                              disabled:
                                enablement.unavailableWorkstations.has(id),
                            })
                          )}
                          selected={chosenWorkstation.option}
                          onSelect={(option) =>
                            setDraft(
                              selectCoworkWorkstation(
                                model.draft,
                                Option.some(option)
                              )
                            )
                          }
                        />
                      )}
                      <View style={styles.after}>
                        <Notice
                          tone="info"
                          message={
                            chosenWorkstation?.origin === "requirement"
                              ? m.booking_cowork_workstation_added(
                                  {},
                                  { locale }
                                )
                              : undefined
                          }
                        />
                      </View>
                    </>
                  )}
                </View>
              )}
            </View>
            {offerCatalog !== undefined && (
              <PassOfferCards
                catalog={offerCatalog}
                draft={model.draft}
                today={today}
              />
            )}
          </>
        )}
      </BookingReadView>
    </BookingStepLayout>
  );
}

/**
 * Why checkout sent the customer back, read inside the step's scroll view,
 * so a restart scrolls it back to the top where this notice says why.
 */
function CoworkRestartNotice({ onReread }: { readonly onReread: () => void }) {
  return <RestartNotice reason={useRestartReason(onReread)} />;
}

/** The first load: the tiers and the calendar in their final layout. */
export function CoworkSkeleton({ locale }: { readonly locale: AppLocale }) {
  return (
    <SkeletonGroup label={m.account_loading({}, { locale })}>
      <BookingSectionHeading
        title={m.booking_cowork_tier_heading({}, { locale })}
        first
      />
      <View style={styles.skeletonTiers}>
        {(["first", "second"] as const).map((key) => (
          <View key={key} style={[styles.skeletonCard, styles.skeletonTier]}>
            <Skeleton width={20} height={20} radius={10} />
            <View style={styles.skeletonText}>
              <Skeleton width="50%" height={14} />
              <Skeleton width="30%" height={12} />
              <Skeleton width="90%" height={10} />
            </View>
            <Skeleton width={72} height={56} radius={radius.tile} />
          </View>
        ))}
      </View>
      <BookingSectionHeading title={m.booking_date_heading({}, { locale })} />
      <View style={styles.skeletonCard}>
        <View style={styles.skeletonMonth}>
          <Skeleton width="40%" height={14} />
        </View>
        {(["a", "b", "c", "d"] as const).map((week) => (
          <View key={week} style={styles.skeletonWeek}>
            {(["1", "2", "3", "4", "5", "6", "7"] as const).map((dayKey) => (
              <View key={dayKey} style={styles.skeletonDay}>
                <Skeleton width="100%" height={28} radius={14} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: color.paper, flex: 1 },
  after: { marginTop: space.sm },
  skeletonTiers: { gap: space.sm },
  skeletonCard: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.group,
    borderWidth: 1,
    padding: space.lg,
  },
  skeletonTier: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: space.md,
  },
  skeletonText: { flex: 1, gap: space.sm },
  skeletonMonth: {
    alignItems: "center",
    marginBottom: 18,
    marginTop: space.xs,
  },
  skeletonWeek: { flexDirection: "row", gap: 10, marginBottom: 14 },
  skeletonDay: { flex: 1 },
});
