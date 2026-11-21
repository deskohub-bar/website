"use client";

import { effectSchemaResolver } from "@deskohub/effect-schema-resolver";
import Interpolate from "@doist/react-interpolate";
import {
  AlertTriangle,
  Clock3,
  Coffee,
  Monitor,
  Moon,
  Wifi,
} from "lucide-react";
import Image, { getImageProps } from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { preload } from "react-dom";
import { type Control, useForm } from "react-hook-form";
import type { PreloadedAdvertisedPrice } from "@/features/checkout/advertised-price";
import type { CheckoutSessionId } from "@/features/checkout/checkout-identifiers";
import {
  getWorkspaceProductCoffeeLinePriceForTier,
  isWorkspaceCoworkCurrentProductTier,
  type WorkspaceCoworkCurrentTier,
  type WorkspaceProductMonitorOption,
  workspaceCoworkCurrentTiers,
  workspaceProductMonitorOptions,
  workspaceProductWorkstationAddonPrice,
} from "@/features/checkout/product-catalog";
import {
  getWorkspaceProductMessage,
  getWorkspaceProductMonitorTitle,
  getWorkspaceProductTierTitle,
  type WorkspaceProductTierCardMessages,
  workspaceProductMonitorDescriptionMessages,
  workspaceProductTierCardMessages,
  workspaceProductTierMessages,
} from "@/features/checkout/product-catalog.i18n";
import openSpaceArtwork from "@/features/cowork/assets/open-space.png";
import reservedDeskArtwork from "@/features/cowork/assets/reserved-desk.png";
import reservedDeskWorkstationArtwork from "@/features/cowork/assets/reserved-desk-workstation.png";
import type { CanonicalPromotionCode } from "@/features/discounts";
import { defaultPhoneRegion, type Locale, m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { EntryPackBookingNotice } from "@/features/passes/components/entry-pack-booking-notice";
import {
  getEntryPackPurchasePath,
  minimumEntryPackPricePerDay,
} from "@/features/passes/entry-pack-discovery";
import { getEntryPackLastUsableDate } from "@/features/passes/pass-offer";
import { getUnlimitedPassPurchasePath } from "@/features/passes/unlimited-pass-discovery";
import { ReservationAdvertisedPrice } from "@/features/reservation/components/reservation-advertised-price";
import { ReservationCheckoutForm } from "@/features/reservation/components/reservation-checkout-form";
import { ReservationFormDateInput } from "@/features/reservation/components/reservation-date-input";
import {
  ReservationCustomerFieldsFallback,
  ReservationSkeletonBlock,
  ReservationSkeletonField,
  ReservationSubmitFallback,
  ReservationFormFallback as SharedReservationFormFallback,
} from "@/features/reservation/components/reservation-form-fallback";
import { ReservationFormLabel } from "@/features/reservation/components/reservation-form-label";
import {
  illustratedReservationTypeOptionLayout,
  ReservationTypeInput,
  ReservationTypeOption,
} from "@/features/reservation/components/reservation-type-input";
import {
  useReservationSelectionUrl,
  useWatchedSelection,
} from "@/features/reservation/components/use-reservation-selection-url";
import {
  getCoworkAddOnAmount,
  getCoworkTierOptionPrice,
} from "@/features/reservation/cowork-advertised-price";
import {
  type CoworkReservationData,
  type CoworkReservationInput,
  coworkReservationSchema,
  getAllowedMonitorOptionsForCoworkTier,
  getCoworkCurrentReservationOrder,
  getCoworkReservationDefaultValues,
  type NormalizedCoworkReservationOrder,
} from "@/features/reservation/cowork-reservation";
import { coworkSelectionLink } from "@/features/reservation/cowork-selection-link";
import { overnightCoworkStayTier } from "@/features/reservation/cowork-stay";
import {
  formatReservationInputDate,
  getCurrentWorkspaceDate,
} from "@/features/reservation/reservation-date";
import type { ReservationCheckoutCustomerForm } from "@/features/reservation/reservation-existing-customer";
import type { PreloadedWorkspaceAvailability } from "@/features/reservation/workspace-availability";
import { GuardedLink as Link } from "@/shared/components/guarded-link";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/shared/components/ui/form";
import { Label } from "@/shared/components/ui/label";
import { Switch } from "@/shared/components/ui/switch";
import { textLink } from "@/shared/components/ui/text-link";
import { currencyCZK } from "@/shared/money/currencies";
import { formatMoney, type Money } from "@/shared/money/money";
import { cn } from "@/shared/utils";
import {
  type CoworkEntryPacks,
  entryPackCoversDate,
  getEntryPackCoworkTier,
  getOfferedEntryPack,
  type InitialCoworkEntryPack,
} from "../cowork-entry-packs";
import {
  CoworkEntryPackBanner,
  CoworkEntryPackCardDialog,
  CoworkEntryPackUnavailable,
} from "./cowork-entry-pack-banner";
import { CoworkOptionalAddonToggle } from "./cowork-optional-addon-toggle";
import { getCoworkReservationSelectionSummary } from "./cowork-reservation-selection-summary";
import { formatCoworkOvernightStay } from "./cowork-stay-display";
import { useCoworkAddonNormalization } from "./use-cowork-addon-normalization";
import { useCoworkAdvertisedPrices } from "./use-cowork-advertised-prices";
import { useCoworkSelectionAvailability } from "./use-cowork-selection-availability";

type CoworkReservationFormProps = {
  bookingPasses?: CoworkEntryPacks;
  entryPackOffered?: boolean;
  initialEntryPack?: InitialCoworkEntryPack;
  initialReservation?: NormalizedCoworkReservationOrder;
  initialAdvertisedPrices?: ReadonlyArray<PreloadedAdvertisedPrice>;
  initialValues?: CoworkReservationInput;
  locale: Locale;
  /**
   * Whether the overnight-stay release is open, so a Reserved Desk can be
   * booked as an overnight stay.
   */
  overnightStayOffered?: boolean;
  checkoutSessionId?: CheckoutSessionId;
  checkoutCustomer: ReservationCheckoutCustomerForm;
  initialAvailability?: ReadonlyArray<PreloadedWorkspaceAvailability>;
  replacementToken?: string;
  submittedCode?: CanonicalPromotionCode;
  /** The workspace date the server rendered, which anchors the calendar range. */
  today: string;
};

const passDiscoveryLinkClassName = cn(
  textLink({ tone: "inherit" }),
  "font-semibold text-navy-blue hover:text-burned-orange"
);

type CoworkReservationFormFallbackProps = Pick<
  CoworkReservationFormProps,
  "locale"
> & {
  showMonitorOption?: boolean;
};

const tierOptions: ReadonlyArray<{
  value: WorkspaceCoworkCurrentTier;
  title: Parameters<typeof getWorkspaceProductMessage>[0];
  description: Parameters<typeof getWorkspaceProductMessage>[0];
}> = workspaceCoworkCurrentTiers.map((tier) => ({
  value: tier,
  ...workspaceProductTierMessages[tier],
}));

const monitorOptions: ReadonlyArray<{
  value: WorkspaceProductMonitorOption;
  description: Parameters<typeof getWorkspaceProductMessage>[0];
}> = workspaceProductMonitorOptions.map((option) => ({
  value: option,
  description: workspaceProductMonitorDescriptionMessages[option],
}));

// The artwork spans 280% of the card's two-fifths illustration column, capped
// at 440px: about 340px in the two-card grid from md, else ~112vw - 128px.
const tierArtworkImage = {
  height: 941,
  sizes: "(min-width: 768px) 340px, min(440px, calc(112vw - 128px))",
  width: 1672,
} as const;

const formatDisplayDate = (date: string, locale: Locale) =>
  formatReservationInputDate(
    date,
    locale,
    m.reservationDatePlaceholder({}, { locale })
  );

export function CoworkReservationForm({
  bookingPasses,
  entryPackOffered = false,
  initialEntryPack,
  initialReservation,
  initialAdvertisedPrices = [],
  initialValues,
  locale,
  overnightStayOffered = false,
  checkoutSessionId,
  checkoutCustomer,
  initialAvailability,
  replacementToken,
  submittedCode,
  today,
}: CoworkReservationFormProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const defaultValues =
    initialValues ??
    (initialReservation
      ? getCoworkReservationDefaultValues(initialReservation)
      : coworkSelectionLink.read(searchParams, { locale }));
  const form = useForm<CoworkReservationInput, unknown, CoworkReservationData>({
    resolver: effectSchemaResolver(
      coworkReservationSchema(defaultPhoneRegion(locale))
    ),
    defaultValues,
    mode: "onBlur",
    reValidateMode: "onChange",
  });
  const selection = useWatchedSelection(coworkSelectionLink, form.control);
  const [packSelection, setPackSelection] = useState<
    InitialCoworkEntryPack | { readonly kind: "card" } | undefined
  >(initialEntryPack);
  const [cardChange, setCardChange] = useState<(() => void) | undefined>();
  const [rejectedBooking, setRejectedBooking] = useState<{
    readonly date: string;
    readonly packId: OrderId;
  }>();
  const {
    entryTier: selectedTier,
    monitorOption: selectedMonitorOption,
    stay: selectedStay,
  } = selection;
  const offersStayChoice =
    overnightStayOffered && selectedTier === overnightCoworkStayTier;
  const isOvernightStay = offersStayChoice && selectedStay === "overnight";
  const selectedPassTier =
    selectedTier === "reserved-desk" && selectedMonitorOption
      ? "reserved-desk-workstation"
      : selectedTier;
  useReservationSelectionUrl(coworkSelectionLink, selection);
  const allowedMonitorOptions =
    getAllowedMonitorOptionsForCoworkTier(selectedTier);
  const {
    advertisedPrices,
    coffeePriceLabel,
    selectedPrice,
    workstationPriceLabel,
  } = useCoworkAdvertisedPrices({
    initialAdvertisedPrices,
    locale,
    selection,
    submittedCode,
  });
  const selectionAvailability = useCoworkSelectionAvailability({
    initialAvailability,
    locale,
    replacementToken,
    selection,
    today,
  });
  const { workstation } = selectionAvailability;
  const availability = selectionAvailability.checkoutAvailability;
  const isWorkstationRequired = workstation.requiredMonitorOption !== undefined;
  const appliedPack =
    packSelection?.kind === "applied"
      ? bookingPasses?.packs.find((pack) => pack.id === packSelection.packId)
      : undefined;
  const workstationCovered = appliedPack?.tier === "reserved-desk-workstation";
  const rejectedPackId =
    rejectedBooking?.date === selection.date
      ? rejectedBooking?.packId
      : undefined;
  const packUnavailable =
    packSelection?.kind === "unavailable" ||
    (packSelection?.kind === "applied" &&
      (!appliedPack ||
        appliedPack.id === rejectedPackId ||
        (workstationCovered && !selectedMonitorOption) ||
        getEntryPackCoworkTier(appliedPack.tier) !== selectedTier ||
        !entryPackCoversDate(appliedPack, selection.date) ||
        bookingPasses?.claimedDates.some((date) => date === selection.date)));
  const offeredPack =
    bookingPasses &&
    (!packSelection || packSelection.kind === "card") &&
    !availability.isPending &&
    !availability.unavailableMessage &&
    isWorkspaceCoworkCurrentProductTier(selectedTier)
      ? getOfferedEntryPack(bookingPasses, {
          date: selection.date,
          excludedPackId: rejectedPackId,
          tier: selectedTier,
          workstation: Boolean(selectedMonitorOption),
          workstationRequired: isWorkstationRequired,
        })
      : undefined;
  const pack = appliedPack ?? offeredPack;
  const coffeeCharge =
    appliedPack && selection.coffee
      ? (getCoworkAddOnAmount(selectedPrice, "coffee") ??
        getWorkspaceProductCoffeeLinePriceForTier(selectedTier))
      : currencyCZK(0);
  const workstationCharge =
    appliedPack?.tier === "reserved-desk" && selectedMonitorOption
      ? (getCoworkAddOnAmount(selectedPrice, "workstation") ??
        workspaceProductWorkstationAddonPrice)
      : currencyCZK(0);
  const packTotal = currencyCZK(coffeeCharge.value + workstationCharge.value);

  const updatePassInUrl = (id?: OrderId) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("pass", id);
    else url.searchParams.delete("pass");
    if (url.href !== window.location.href) {
      window.history.replaceState(null, "", url);
    }
  };
  const payByCard = () => {
    setPackSelection({ kind: "card" });
    updatePassInUrl();
  };
  const changeUncoveredOption = (change: () => void) => {
    setCardChange(() => change);
  };
  const {
    isCoffeeOptional,
    isWorkstationOptional,
    onManualWorkstationSelection,
    onTierChange,
  } = useCoworkAddonNormalization({
    form,
    selection,
    workstation,
    workstationIncluded: workstationCovered,
    workstationOnlyWhenRequired: appliedPack?.tier === "reserved-desk",
  });

  return (
    <ReservationCheckoutForm
      checkoutCustomer={checkoutCustomer}
      advertisedPrice={
        appliedPack
          ? {
              ...advertisedPrices.checkout,
              sale: undefined,
              total: { amount: packTotal },
            }
          : advertisedPrices.checkout
      }
      availability={
        packUnavailable
          ? {
              ...availability,
              unavailableMessage: m.coworkEntryPackUnavailableDescription(
                {},
                { locale }
              ),
            }
          : availability
      }
      checkoutSessionId={checkoutSessionId}
      entryPackId={appliedPack?.id}
      form={form}
      getReservation={getCoworkCurrentReservationOrder}
      locale={locale}
      onEntryPackUnavailable={() => {
        if (appliedPack)
          setRejectedBooking({ date: selection.date, packId: appliedPack.id });
        router.refresh();
      }}
      selectionSummary={getCoworkReservationSelectionSummary(selection, locale)}
      selection={{
        kind: coworkSelectionLink.kind,
        fromSearchParams: (searchParams) =>
          coworkSelectionLink.readSelection(searchParams, { locale }),
      }}
    >
      <div aria-live="polite" className="empty:absolute">
        {packSelection?.kind === "invalid-link" || packUnavailable ? (
          <CoworkEntryPackUnavailable
            invalidLink={packSelection?.kind === "invalid-link"}
            locale={locale}
            onClear={payByCard}
          />
        ) : (
          pack && (
            <CoworkEntryPackBanner
              applying={Boolean(appliedPack)}
              locale={locale}
              onAction={
                appliedPack
                  ? payByCard
                  : () => {
                      setPackSelection({ kind: "applied", packId: pack.id });
                      updatePassInUrl(pack.id);
                    }
              }
              pack={pack}
            />
          )
        )}
      </div>
      <CoworkEntryPackCardDialog
        locale={locale}
        onCancel={() => setCardChange(undefined)}
        onConfirm={() => {
          payByCard();
          cardChange?.();
          setCardChange(undefined);
        }}
        open={Boolean(cardChange)}
      />
      <FormField
        control={form.control}
        name="entryTier"
        render={({ field }) => (
          <FormItem>
            <ReservationFormLabel required>
              {m.reservationTierLabel({}, { locale })}
            </ReservationFormLabel>
            <FormControl>
              <ReservationTypeInput
                aria-required="true"
                idPrefix="reservation-entry-tier"
                inputRef={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                onChange={(tier) => {
                  const change = () => {
                    field.onChange(tier);
                    // Only a Reserved Desk offers an overnight stay.
                    if (tier !== overnightCoworkStayTier) {
                      form.setValue("stay", undefined);
                    }
                    onTierChange(tier);
                  };
                  if (
                    appliedPack &&
                    tier !== getEntryPackCoworkTier(appliedPack.tier)
                  ) {
                    changeUncoveredOption(change);
                  } else {
                    change();
                  }
                }}
                presentation="illustrated"
                value={field.value}
              >
                {tierOptions.map((option) => {
                  const artworkSource = {
                    "open-space": openSpaceArtwork,
                    "reserved-desk":
                      selectedMonitorOption === undefined
                        ? reservedDeskArtwork
                        : reservedDeskWorkstationArtwork,
                  }[option.value];
                  const optionTitle = getWorkspaceProductMessage(
                    option.title,
                    locale
                  );
                  const isUnavailable =
                    selectionAvailability.unavailableTiers.has(option.value);
                  const tierPrice = getCoworkTierOptionPrice(
                    advertisedPrices,
                    option.value
                  );
                  const originalAmount = tierPrice?.originalAmount;
                  const usesEntry =
                    appliedPack &&
                    selectedTier === option.value &&
                    !packUnavailable;
                  const cardPrice = tierPrice ? (
                    <ReservationAdvertisedPrice
                      amount={tierPrice.amount}
                      originalAmountClassName={
                        originalAmount ? "text-[0.6em]" : undefined
                      }
                      locale={locale}
                      originalAmount={originalAmount}
                      suffix={
                        <span className="ml-1 text-sm font-normal normal-case tracking-normal text-navy-blue/60">
                          {m.coworkReservationPricePeriodSuffix({}, { locale })}
                        </span>
                      }
                    />
                  ) : (
                    <ReservationSkeletonBlock className="h-4 w-24 bg-aquamarine-green/15" />
                  );
                  return (
                    <ReservationTypeOption
                      key={option.value}
                      disabled={isUnavailable}
                      illustration={
                        <Image
                          aria-hidden="true"
                          alt=""
                          className={cn(
                            "absolute top-0 right-0 h-auto w-[280%] max-w-[440px] -translate-y-[25%] object-contain object-right-top @min-[400px]/card:translate-x-0",
                            {
                              "open-space": "translate-x-[10%]",
                              "reserved-desk": "translate-x-[20%]",
                            }[option.value]
                          )}
                          {...tierArtworkImage}
                          // The initially selected tier's artwork is the LCP.
                          {...(option.value === defaultValues.entryTier && {
                            fetchPriority: "high",
                            preload: true,
                          })}
                          src={artworkSource}
                        />
                      }
                      price={
                        usesEntry ? (
                          <span className="text-2xl font-semibold text-navy-blue">
                            {m.coworkEntryPackOneEntry({}, { locale })}
                          </span>
                        ) : (
                          cardPrice
                        )
                      }
                      priceReady={Boolean(usesEntry || tierPrice)}
                      title={optionTitle}
                      value={option.value}
                    >
                      <CoworkTierDescription
                        locale={locale}
                        tier={option.value}
                      />
                      <CoworkTierPerks locale={locale} tier={option.value} />
                    </ReservationTypeOption>
                  );
                })}
              </ReservationTypeInput>
            </FormControl>
            <FormMessage />
            {entryPackOffered &&
              !pack &&
              packSelection?.kind !== "unavailable" &&
              !isOvernightStay &&
              (selectedPassTier === "reserved-desk-workstation" ||
                isWorkspaceCoworkCurrentProductTier(selectedPassTier)) && (
                <p className="pt-1 text-sm leading-6 text-navy-blue/60">
                  <Interpolate
                    string={m.entryPackDiscoveryCoworkLink(
                      {
                        price: formatMoney(minimumEntryPackPricePerDay, locale),
                      },
                      { locale }
                    )}
                    mapping={{
                      packLink: (label) => (
                        <Link
                          className={passDiscoveryLinkClassName}
                          href={getEntryPackPurchasePath(
                            locale,
                            selectedPassTier
                          )}
                        >
                          {label}
                        </Link>
                      ),
                    }}
                  />
                  {" · "}
                  <Link
                    className={passDiscoveryLinkClassName}
                    href={getUnlimitedPassPurchasePath(
                      locale,
                      selectedPassTier,
                      selection.date
                    )}
                  >
                    {m.passUnlimited({}, { locale })}
                  </Link>
                </p>
              )}
          </FormItem>
        )}
      />

      <div data-cowork-date-addon-row className="grid gap-5 md:grid-cols-2">
        <div data-cowork-date-column className="space-y-5">
          <CoworkReservationDateField
            control={form.control}
            locale={locale}
            maximumDate={
              appliedPack &&
              getEntryPackLastUsableDate(appliedPack.validUntil).toString()
            }
            minimumDate={appliedPack?.validFrom}
            offersStayChoice={offersStayChoice}
            overnight={isOvernightStay}
            unavailableDates={
              appliedPack
                ? new Set([
                    ...selectionAvailability.unavailableDates,
                    ...(bookingPasses?.claimedDates ?? []),
                  ])
                : selectionAvailability.unavailableDates
            }
          />

          {selectionAvailability.selectedDateNotices.length > 0 && (
            <div className="space-y-3">
              {selectionAvailability.selectedDateNotices.map((notice) => (
                <p
                  key={`${notice.date}-${notice.startsAt}-${notice.endsAt}`}
                  aria-live="polite"
                  className="flex items-start gap-2 rounded-2xl border border-dashed border-sunset-yellow/45 bg-sunset-yellow/14 px-4 py-3 text-sm leading-6 text-navy-blue/50"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-chilean-fire" />
                  <span>
                    {m.reservationAvailabilityPartialNotice(
                      {
                        startsAt: notice.startsAt,
                        endsAt: notice.endsAt,
                      },
                      { locale }
                    )}
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>

        {isCoffeeOptional && (
          <CoworkCoffeeAddonField
            control={form.control}
            locale={locale}
            priceLabel={
              coffeePriceLabel ??
              (appliedPack
                ? formatMoney(
                    getWorkspaceProductCoffeeLinePriceForTier(selectedTier),
                    locale
                  )
                : undefined)
            }
          />
        )}

        {isWorkstationOptional && (
          <CoworkWorkstationAddonField
            allowedMonitorOptions={allowedMonitorOptions}
            control={form.control}
            isWorkstationRequired={isWorkstationRequired}
            workstationCovered={workstationCovered}
            monitorOptionsAvailabilitySettled={workstation.settled}
            locale={locale}
            onManualSelection={onManualWorkstationSelection}
            onUncoveredSelection={
              appliedPack?.tier === "reserved-desk"
                ? changeUncoveredOption
                : undefined
            }
            priceLabel={
              workstationCovered
                ? formatMoney(currencyCZK(0), locale)
                : (workstationPriceLabel ??
                  (appliedPack
                    ? formatMoney(workspaceProductWorkstationAddonPrice, locale)
                    : undefined))
            }
            unavailableMonitorOptions={workstation.unavailableMonitorOptions}
          />
        )}
      </div>
      {appliedPack && !packUnavailable && (
        <>
          <CoworkEntryPackPrice
            coffee={coffeeCharge}
            locale={locale}
            total={packTotal}
            workstation={workstationCharge}
          />
          <EntryPackBookingNotice locale={locale} />
        </>
      )}
    </ReservationCheckoutForm>
  );
}

function CoworkEntryPackPrice({
  coffee,
  locale,
  total,
  workstation,
}: {
  readonly coffee: Money;
  readonly locale: Locale;
  readonly total: Money;
  readonly workstation: Money;
}) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 rounded-3xl border border-navy-blue/10 bg-white/75 p-5 text-sm text-navy-blue sm:p-6">
      <dt>{m.coworkEntryPackBookingLine({}, { locale })}</dt>
      <dd className="text-end font-semibold">
        {formatMoney(currencyCZK(0), locale)}
      </dd>
      {coffee.value > 0 && (
        <>
          <dt>{m.checkoutStatusSummaryCoffeeLabel({}, { locale })}</dt>
          <dd className="text-end font-semibold">
            {formatMoney(coffee, locale)}
          </dd>
        </>
      )}
      {workstation.value > 0 && (
        <>
          <dt>{m.reservationWorkstationLabel({}, { locale })}</dt>
          <dd className="text-end font-semibold">
            {formatMoney(workstation, locale)}
          </dd>
        </>
      )}
      <dt className="mt-2 border-t border-navy-blue/10 pt-3 font-semibold">
        {m.coworkEntryPackToPay({}, { locale })}
      </dt>
      <dd className="mt-2 border-t border-navy-blue/10 pt-3 text-end text-lg font-semibold">
        {formatMoney(total, locale)}
      </dd>
    </dl>
  );
}

/**
 * A tier card's description. The loading fallback's `placeholder` copy
 * leaves out the form's data hooks, so only the form's copy matches them.
 */
function CoworkTierDescription({
  locale,
  placeholder = false,
  tier,
}: {
  readonly locale: Locale;
  readonly placeholder?: boolean;
  readonly tier: WorkspaceCoworkCurrentTier;
}) {
  return (
    <div
      className="relative z-10 col-start-1 row-start-3 mb-3 min-h-[5.625rem] max-w-full break-words pt-1 text-sm leading-5 text-navy-blue/70"
      {...(!placeholder && {
        "data-cowork-tier-showcase": tier,
        "data-reservation-type-description": tier,
      })}
    >
      <span className="box-decoration-clone rounded-sm bg-white/85 px-1 py-0.5 group-has-[input:checked]:bg-[color:color-mix(in_srgb,var(--color-burned-orange)_8%,white)]/85">
        {getWorkspaceProductMessage(
          workspaceProductTierCardMessages[tier].description,
          locale
        )}
      </span>
    </div>
  );
}

/**
 * A tier card's perks. The loading fallback's `placeholder` copy leaves out
 * the form's data hooks and element IDs.
 */
function CoworkTierPerks({
  locale,
  placeholder = false,
  tier,
}: {
  readonly locale: Locale;
  readonly placeholder?: boolean;
  readonly tier: WorkspaceCoworkCurrentTier;
}) {
  const content: WorkspaceProductTierCardMessages =
    workspaceProductTierCardMessages[tier];
  const perkIcons = {
    "open-space": [Wifi],
    "reserved-desk": [Clock3, Coffee, Monitor],
  }[tier];
  const perksLabelId = `cowork-tier-perks-label-${tier}`;

  return (
    <div
      className="relative z-10 col-start-1 col-end-3 row-start-4 pb-1 text-sm leading-5 text-navy-blue/70"
      {...(!placeholder && { "data-reservation-type-perks": tier })}
    >
      {placeholder ? (
        <span className="sr-only">
          {getWorkspaceProductMessage(content.perksLabel, locale)}
        </span>
      ) : (
        <span id={perksLabelId} className="sr-only">
          {getWorkspaceProductMessage(content.perksLabel, locale)}
        </span>
      )}
      <ul
        {...(!placeholder && { "aria-labelledby": perksLabelId })}
        className="space-y-2"
      >
        {content.perks.map((perk, index) => {
          const text = getWorkspaceProductMessage(perk.message, locale);
          const PerkIcon = perkIcons[index];

          return (
            <li
              key={`${perk.marker ?? "bullet"}-${text}`}
              className={cn(
                "flex items-center gap-2 leading-6",
                perk.highlighted && "text-burned-orange"
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-blue/7 text-navy-blue"
              >
                {PerkIcon && <PerkIcon className="h-4 w-4" focusable="false" />}
              </span>
              <span className="min-w-0 break-words">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CoworkCoffeeAddonField({
  control,
  locale,
  priceLabel,
}: {
  readonly control: Control<
    CoworkReservationInput,
    unknown,
    CoworkReservationData
  >;
  readonly locale: Locale;
  readonly priceLabel?: string;
}) {
  return (
    <FormField
      control={control}
      name="coffee"
      render={({ field }) => (
        <FormItem className="contents" data-cowork-addon-column>
          <CoworkOptionalAddonToggle
            addon="coffee"
            checked={field.value}
            icon={Coffee}
            label={m.reservationCoffeeLabel({}, { locale })}
            onBlur={field.onBlur}
            onCheckedChange={(checked) => field.onChange(Boolean(checked))}
            priceLabel={priceLabel}
          >
            <FormMessage />
          </CoworkOptionalAddonToggle>
        </FormItem>
      )}
    />
  );
}

function CoworkWorkstationAddonField({
  allowedMonitorOptions,
  control,
  isWorkstationRequired,
  monitorOptionsAvailabilitySettled,
  locale,
  onManualSelection,
  onUncoveredSelection,
  priceLabel,
  unavailableMonitorOptions,
  workstationCovered,
}: {
  readonly allowedMonitorOptions: ReadonlyArray<WorkspaceProductMonitorOption>;
  readonly control: Control<
    CoworkReservationInput,
    unknown,
    CoworkReservationData
  >;
  readonly isWorkstationRequired: boolean;
  readonly monitorOptionsAvailabilitySettled: boolean;
  readonly locale: Locale;
  readonly onManualSelection: () => void;
  readonly onUncoveredSelection?: (change: () => void) => void;
  readonly priceLabel?: string;
  readonly unavailableMonitorOptions: ReadonlySet<WorkspaceProductMonitorOption>;
  readonly workstationCovered: boolean;
}) {
  const monitorSetupId = useId();
  const monitorSetupLabelId = `${monitorSetupId}-label`;
  const visibleMonitorOptions = monitorOptions.filter((option) =>
    allowedMonitorOptions.includes(option.value)
  );
  const isMonitorOptionDisabled = (option: WorkspaceProductMonitorOption) =>
    unavailableMonitorOptions.has(option) || !monitorOptionsAvailabilitySettled;
  const selectableMonitorOptions = visibleMonitorOptions.filter(
    (option) => !isMonitorOptionDisabled(option.value)
  );
  // RHF keeps one focus target per field, so validation focus lands on the
  // selected radio, or the first one the visitor can choose.
  const getMonitorFocusOption = (selectedOption: string | undefined) =>
    (
      selectableMonitorOptions.find(
        (option) => option.value === selectedOption
      ) ??
      selectableMonitorOptions[0] ??
      visibleMonitorOptions[0]
    )?.value;

  return (
    <FormField
      control={control}
      name="monitorOption"
      render={({ field }) => (
        <FormItem className="contents" data-cowork-addon-column>
          <CoworkOptionalAddonToggle
            addon="workstation"
            checked={
              field.value !== undefined ||
              isWorkstationRequired ||
              workstationCovered
            }
            disabled={isWorkstationRequired || workstationCovered}
            icon={Monitor}
            info={
              isWorkstationRequired
                ? {
                    triggerLabel:
                      m.reservationWorkstationRequiredTooltipTrigger(
                        {},
                        { locale }
                      ),
                    content: m.reservationWorkstationRequiredTooltipContent(
                      {},
                      { locale }
                    ),
                  }
                : undefined
            }
            label={m.reservationWorkstationLabel({}, { locale })}
            onBlur={field.onBlur}
            onCheckedChange={(checked) => {
              if (isWorkstationRequired || workstationCovered) return;
              const change = () => {
                onManualSelection();
                field.onChange(checked ? allowedMonitorOptions[0] : undefined);
              };
              if (checked && onUncoveredSelection) onUncoveredSelection(change);
              else change();
            }}
            priceLabel={priceLabel}
          />
          {field.value !== undefined && (
            <div
              data-cowork-monitor-options
              className="rounded-3xl border border-aquamarine-green/25 bg-aquamarine-green/8 p-4 md:col-span-2"
            >
              <Label
                id={monitorSetupLabelId}
                className="block pt-1 text-sm text-navy-blue/60"
              >
                {m.reservationMonitorLabel({}, { locale })}
              </Label>
              <FormControl>
                <div
                  id={monitorSetupId}
                  role="radiogroup"
                  aria-labelledby={monitorSetupLabelId}
                  className="grid gap-3 sm:grid-cols-3"
                >
                  {visibleMonitorOptions.map((option) => {
                    const isSelected = field.value === option.value;
                    const isDisabled = isMonitorOptionDisabled(option.value);

                    return (
                      <label
                        key={option.value}
                        className={cn(
                          "cursor-pointer rounded-[1.1rem] border p-3 transition hover:-translate-y-0.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-navy-blue",
                          isDisabled &&
                            "cursor-not-allowed opacity-45 hover:translate-y-0",
                          isSelected
                            ? "border-aquamarine-green bg-white ring-4 ring-aquamarine-green/15"
                            : "border-navy-blue/10 bg-white/75 hover:border-aquamarine-green/55"
                        )}
                      >
                        <input
                          type="radio"
                          className="sr-only"
                          checked={isSelected}
                          value={option.value}
                          disabled={isDisabled}
                          name={field.name}
                          onBlur={field.onBlur}
                          onChange={() => {
                            if (!isDisabled) {
                              onManualSelection();
                              field.onChange(option.value);
                            }
                          }}
                          ref={
                            option.value === getMonitorFocusOption(field.value)
                              ? field.ref
                              : undefined
                          }
                        />
                        <span className="block font-semibold text-navy-blue">
                          {getWorkspaceProductMonitorTitle(
                            option.value,
                            locale
                          )}
                        </span>
                        <span className="mt-1 block text-sm leading-5 text-navy-blue/60">
                          {getWorkspaceProductMessage(
                            option.description,
                            locale
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </FormControl>
            </div>
          )}
          <FormMessage className="md:col-span-2" />
        </FormItem>
      )}
    />
  );
}

/**
 * The Reserved Desk's overnight-stay switch. Off writes the explicit day stay
 * rather than clearing the field, because a cleared controlled field shows its
 * default again (an opened overnight link would stay on); the link and the
 * order drop a day stay, so it still books as unset.
 */
function CoworkOvernightStaySwitch({
  control,
  locale,
}: {
  readonly control: Control<
    CoworkReservationInput,
    unknown,
    CoworkReservationData
  >;
  readonly locale: Locale;
}) {
  const switchId = useId();

  return (
    <FormField
      control={control}
      name="stay"
      render={({ field }) => (
        <div className="flex shrink-0 items-center gap-2">
          <Label
            className={cn(
              "sr-only cursor-pointer @md:not-sr-only",
              field.value === "overnight"
                ? "text-burned-orange"
                : "text-navy-blue/72"
            )}
            htmlFor={switchId}
          >
            {m.coworkReservationStayOvernight({}, { locale })}
          </Label>
          <Switch
            checked={field.value === "overnight"}
            icon={<Moon />}
            id={switchId}
            onBlur={field.onBlur}
            onCheckedChange={(overnight) =>
              field.onChange(overnight ? "overnight" : "day")
            }
          />
        </div>
      )}
    />
  );
}

function CoworkReservationDateField({
  control,
  locale,
  maximumDate,
  minimumDate,
  offersStayChoice,
  overnight,
  unavailableDates,
}: {
  readonly control: Control<
    CoworkReservationInput,
    unknown,
    CoworkReservationData
  >;
  readonly locale: Locale;
  readonly maximumDate?: string;
  readonly minimumDate?: string;
  /** Whether the date's heading row carries the overnight-stay switch. */
  readonly offersStayChoice: boolean;
  /** Whether the date is an overnight stay's arrival. */
  readonly overnight: boolean;
  readonly unavailableDates: ReadonlySet<string>;
}) {
  return (
    <FormField
      control={control}
      name="date"
      render={({ field }) => (
        <FormItem>
          {/* The switch's text shows only where the row has room for it. */}
          <div className="@container flex items-center justify-between gap-3">
            <ReservationFormLabel className="whitespace-nowrap" required>
              {m.reservationDateLabel({}, { locale })}
            </ReservationFormLabel>
            {offersStayChoice && (
              <CoworkOvernightStaySwitch control={control} locale={locale} />
            )}
          </div>
          <ReservationFormDateInput
            {...field}
            displayValue={
              overnight && field.value ? (
                <span
                  data-cowork-overnight-stay-times
                  className="flex items-start gap-1.5"
                >
                  <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-burned-orange" />
                  {formatCoworkOvernightStay(field.value, locale)}
                </span>
              ) : (
                formatDisplayDate(field.value, locale)
              )
            }
            label={m.reservationDateLabel({}, { locale })}
            locale={locale}
            maximum={maximumDate}
            minimum={() => {
              const today = getCurrentWorkspaceDate().toString();
              return minimumDate && minimumDate > today ? minimumDate : today;
            }}
            unavailableDates={unavailableDates}
          />
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function CoworkReservationFormFallback({
  locale,
  showMonitorOption = false,
}: CoworkReservationFormFallbackProps) {
  preloadDefaultTierArtwork();

  return (
    <SharedReservationFormFallback
      label={m.reservationFormTitle({}, { locale })}
      overview={
        <div className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-[0.14em] text-navy-blue/72">
            {m.reservationTierLabel({}, { locale })}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {workspaceCoworkCurrentTiers.map((tier) => (
              <div
                className={cn(
                  illustratedReservationTypeOptionLayout,
                  "bg-white outline outline-1 -outline-offset-1 outline-navy-blue/10"
                )}
                key={tier}
              >
                <div className="col-start-1 col-end-3 row-start-1 mb-2 flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 break-words text-[1.375rem] font-semibold leading-7 lg:text-2xl lg:leading-8">
                    {getWorkspaceProductTierTitle(tier, locale)}
                  </p>
                  <span
                    aria-hidden="true"
                    className="mt-1 h-6 w-6 shrink-0 rounded-full border-2 border-navy-blue/25 sm:h-7 sm:w-7"
                  />
                </div>
                {/* Prices load with the form; the copy around them is static. */}
                <div
                  aria-hidden="true"
                  className="col-start-1 row-start-2 mb-2 py-1"
                >
                  <ReservationSkeletonBlock className="h-8 w-28 bg-aquamarine-green/15 lg:h-9" />
                </div>
                <CoworkTierDescription
                  locale={locale}
                  placeholder
                  tier={tier}
                />
                <CoworkTierPerks locale={locale} placeholder tier={tier} />
              </div>
            ))}
          </div>
        </div>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <ReservationSkeletonField />
        <ReservationSkeletonField />
      </div>

      {showMonitorOption && <SkeletonMonitorOptionField />}

      <ReservationCustomerFieldsFallback />

      <div className="space-y-3 pt-1">
        <ReservationSubmitFallback />
        <div className="space-y-2">
          <ReservationSkeletonBlock className="h-4 w-full" />
          <ReservationSkeletonBlock className="h-4 w-4/5" />
        </div>
      </div>
    </SharedReservationFormFallback>
  );
}

/**
 * Starts the default tier artwork, the page's LCP, while the form streams in.
 * React dedupes it with the selected tier image's own preload.
 */
function preloadDefaultTierArtwork() {
  const { props } = getImageProps({
    ...tierArtworkImage,
    alt: "",
    fetchPriority: "high",
    src: openSpaceArtwork,
  });
  preload(props.src, {
    as: "image",
    fetchPriority: "high",
    imageSizes: props.sizes,
    imageSrcSet: props.srcSet,
  });
}

function SkeletonMonitorOptionField() {
  return (
    <div className="rounded-3xl border border-aquamarine-green/25 bg-aquamarine-green/8 p-4">
      <div className="space-y-3">
        <ReservationSkeletonBlock className="h-4 w-40 bg-aquamarine-green/15" />
        <div className="grid gap-3 sm:grid-cols-3">
          {monitorOptions.map((option) => (
            <div
              className="rounded-[1.1rem] border border-navy-blue/10 bg-white/75 p-3"
              key={option.value}
            >
              <ReservationSkeletonBlock className="h-5 w-16" />
              <div className="mt-2 space-y-2">
                <ReservationSkeletonBlock className="h-3 w-full" />
                <ReservationSkeletonBlock className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
