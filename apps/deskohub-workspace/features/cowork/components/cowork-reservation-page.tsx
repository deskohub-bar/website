import { Effect, Layer, Option } from "effect";
import { redirect } from "next/navigation";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { getAccountSignInPath } from "@/features/account/routes";
import {
  isWorkspaceCoworkCurrentProductTier,
  workspaceProductMonitorOptions,
} from "@/features/checkout/product-catalog";
import { type Locale, m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { isCoworkPassesPageOpenAfterConnection } from "@/features/passes/backend/cowork-passes-release-gate.server";
import { recoverEntryPackGiftClaims } from "@/features/passes/backend/entry-pack-gift";
import {
  type HeldEntryPack,
  listHeldEntryPacks,
} from "@/features/passes/backend/held-entry-packs";
import { isOvernightStayOfferedAfterConnection } from "@/features/reservation/backend/overnight-stay-release-gate.server";
import { isRememberedCoworkOfferAvailable } from "@/features/reservation/backend/reservation-existing-customer.server";
import { createReservationPage } from "@/features/reservation/components/create-reservation-page.server";
import { getCoworkDateAdvertisedPriceRequests } from "@/features/reservation/cowork-advertised-price";
import {
  type CoworkReservationInput,
  getCoworkReservationDefaultValues,
} from "@/features/reservation/cowork-reservation";
import { coworkSelectionLink } from "@/features/reservation/cowork-selection-link";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { reservationCheckoutStepQueryParam } from "@/features/reservation/reservation-checkout-step";
import { getCoworkPageOfferings } from "@/features/reservation/reservation-page-offerings";
import {
  coworkReservationPath,
  getCoworkReservationPath,
} from "@/features/reservation/routes";
import { getCoworkAvailabilityQueries } from "@/features/reservation/workspace-availability";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import { Button } from "@/shared/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { getSearchParam } from "@/shared/utils";
import { toURLSearchParams } from "@/shared/utils/search-params";
import {
  type CoworkEntryPacks,
  firstEntryPackDate,
  getEntryPackCoworkTier,
  type InitialCoworkEntryPack,
} from "../cowork-entry-packs";
import {
  CoworkReservationForm,
  CoworkReservationFormFallback,
} from "./cowork-reservation-form";

const withWorkspaceDate = (values: CoworkReservationInput, today: string) =>
  values.date ? values : { ...values, date: today };

type CoworkReservationPageData = {
  readonly entryPackOffered: boolean;
  readonly heldEntryPacks: readonly HeldEntryPack[];
  /** Whether a Reserved Desk can be booked as an overnight stay. */
  readonly overnightStayOffered: boolean;
};

type CoworkPageSelection = CoworkReservationInput & {
  readonly bookingPasses: CoworkEntryPacks;
  readonly initialEntryPack?: InitialCoworkEntryPack;
};

const loadHeldEntryPacks = Effect.fn("cowork.loadHeldEntryPacks")(function* () {
  const account = yield* CurrentCustomerAccount;
  const active = yield* Effect.option(account.requireActive);
  if (Option.isNone(active)) return [];
  yield* recoverEntryPackGiftClaims(
    active.value.accountId,
    active.value.verifiedSignInAt
  );
  return yield* listHeldEntryPacks(active.value.accountId);
});

const getBookingPasses = (
  heldEntryPacks: readonly HeldEntryPack[],
  today: string,
  restored?: {
    readonly passId: OrderId;
    readonly reservationId: WorkspaceReservationId;
  }
): CoworkEntryPacks => {
  const claimedDates = new Set<CoworkEntryPacks["claimedDates"][number]>();
  const packs = heldEntryPacks.flatMap((pack) => {
    const editedDate =
      restored?.passId === pack.id
        ? pack.reservedEntryDates[restored.reservationId]
        : undefined;
    for (const date of pack.claimedDates) {
      if (date >= today && date !== editedDate) claimedDates.add(date);
    }
    const entriesLeft = pack.entriesLeft + Number(editedDate !== undefined);
    return pack.status === "active" &&
      (pack.giftIssuedAt === null || pack.giftClaimedAt !== null) &&
      pack.giftPaymentIsUsable &&
      entriesLeft > 0 &&
      today < pack.validUntil
      ? [
          {
            id: pack.id,
            tier: pack.tier,
            entryCount: pack.entryCount,
            entriesLeft,
            validFrom: pack.validFrom,
            validUntil: pack.validUntil,
          },
        ]
      : [];
  });
  return { packs, claimedDates: [...claimedDates] };
};

const applyEntryPack = (
  values: CoworkReservationInput,
  bookingPasses: CoworkEntryPacks,
  passId: string | undefined,
  today: string,
  dateWasRequested: boolean
): CoworkPageSelection => {
  if (passId === undefined) return { ...values, bookingPasses };

  const pack = bookingPasses.packs.find(({ id }) => id === passId);
  const date = dateWasRequested
    ? values.date
    : pack && firstEntryPackDate(pack, today, bookingPasses.claimedDates);

  if (!pack || !date) {
    return {
      ...values,
      bookingPasses,
      initialEntryPack: { kind: "invalid-link" },
    };
  }

  const entryTier = getEntryPackCoworkTier(pack.tier);
  return {
    ...values,
    bookingPasses,
    initialEntryPack: { kind: "applied", packId: pack.id },
    date,
    entryTier,
    coffee: entryTier !== "open-space" || values.coffee,
    monitorOption:
      pack.tier === "reserved-desk-workstation"
        ? (values.monitorOption ?? workspaceProductMonitorOptions[0])
        : undefined,
    stay: entryTier === "reserved-desk" ? values.stay : undefined,
  };
};

/** Drops a linked or restored overnight stay the page doesn't offer. */
const withOfferedStay = (
  values: CoworkReservationInput,
  { overnightStayOffered }: CoworkReservationPageData
): CoworkReservationInput =>
  overnightStayOffered ? values : { ...values, stay: undefined };

export const coworkReservationPage = createReservationPage({
  breadcrumbs: (locale) => [
    { pathname: "/coworking", name: m.coworkingBreadcrumb({}, { locale }) },
    {
      pathname: coworkReservationPath,
      name: m.reservationCoworkBreadcrumb({}, { locale }),
    },
  ],
  fallback: (locale) => <CoworkReservationFormFallback locale={locale} />,
  kind: "cowork",
  loadPageData: async (): Promise<CoworkReservationPageData> => {
    const [entryPackOffered, overnightStayOffered] = await Promise.all([
      isCoworkPassesPageOpenAfterConnection(),
      isOvernightStayOfferedAfterConnection(),
    ]);
    return { entryPackOffered, heldEntryPacks: [], overnightStayOffered };
  },
  loadFormPageData: async (pageData, request) => {
    if (!pageData.entryPackOffered) return pageData;
    const {
      checkoutAccount,
      locale,
      restoredReservation,
      searchParams,
      verifiedContactReturn,
    } = request;
    if (
      !restoredReservation &&
      getSearchParam(searchParams, "pass") !== undefined
    ) {
      const params = toURLSearchParams(searchParams);
      const bookingPath = getCoworkReservationPath(locale);
      if (checkoutAccount.status === "signed-out") {
        redirect(getAccountSignInPath(locale, `${bookingPath}?${params}`));
      }
      if (
        verifiedContactReturn &&
        params.get(reservationCheckoutStepQueryParam) === "contact"
      ) {
        params.delete(reservationCheckoutStepQueryParam);
        redirect(`${bookingPath}?${params}`);
      }
    }
    const heldEntryPacks = await loadHeldEntryPacks().pipe(
      Effect.provide(
        Layer.mergeAll(WorkspaceDatabase.Default, CurrentCustomerAccount.Live)
      ),
      runWorkspaceEffectOrElse("cowork.load-held-entry-packs", {
        boundary: "page",
        failureCode: "cowork.held-entry-packs-unavailable",
        orElse: (): readonly HeldEntryPack[] => [],
      })
    );
    return { ...pageData, heldEntryPacks };
  },
  pathname: coworkReservationPath,
  prefillsContact: true,
  // A historical tier can't be booked again, so its customer starts over.
  restore: (
    reservation,
    searchParams,
    { entryPack, locale, pageData, today }
  ) => {
    if (!isWorkspaceCoworkCurrentProductTier(reservation.entryTier)) {
      return {
        kind: "replaced",
        content: <CoworkOfferReplaced locale={locale} />,
      };
    }

    const bookingPasses = getBookingPasses(
      pageData.heldEntryPacks,
      today,
      entryPack
    );
    const signedValues = getCoworkReservationDefaultValues(reservation);
    const values = withOfferedStay(
      withWorkspaceDate(
        coworkSelectionLink.restore(signedValues, searchParams, { locale }),
        today
      ),
      pageData
    );
    const restoredPack =
      entryPack &&
      bookingPasses.packs.find(({ id }) => id === entryPack.passId);
    const keepsPackTier =
      !restoredPack ||
      (values.entryTier === getEntryPackCoworkTier(restoredPack.tier) &&
        (restoredPack.tier !== "reserved-desk-workstation" ||
          values.monitorOption));
    const initialValues: CoworkPageSelection = {
      ...(keepsPackTier ? values : withOfferedStay(signedValues, pageData)),
      date: values.date,
      bookingPasses,
      initialEntryPack: restoredPack
        ? { kind: "applied", packId: restoredPack.id }
        : entryPack && { kind: "unavailable" },
    };
    return {
      kind: "restored",
      values: initialValues,
    };
  },
  /**
   * Cowork form values from a link, filled from the customer's last cowork
   * offer only while that offer is still bookable on the form's date.
   */
  read: Effect.fn("coworkReservationPage.read")(function* (
    searchParams,
    { lastReservation, locale, pageData, today }
  ) {
    const queryValues = withOfferedStay(
      withWorkspaceDate(
        coworkSelectionLink.read(searchParams, { locale }),
        today
      ),
      pageData
    );
    const bookingPasses = getBookingPasses(pageData.heldEntryPacks, today);
    const requestedPack = pageData.entryPackOffered
      ? getSearchParam(searchParams, "pass")
      : undefined;
    if (requestedPack !== undefined || !lastReservation) {
      return applyEntryPack(
        queryValues,
        bookingPasses,
        requestedPack,
        today,
        getSearchParam(searchParams, "date") === queryValues.date
      );
    }

    const rememberedValues = withOfferedStay(
      withWorkspaceDate(
        coworkSelectionLink.read(searchParams, { locale, lastReservation }),
        today
      ),
      pageData
    );
    if (
      rememberedValues.entryTier === queryValues.entryTier &&
      rememberedValues.coffee === queryValues.coffee &&
      rememberedValues.monitorOption === queryValues.monitorOption
    ) {
      return { ...queryValues, bookingPasses };
    }

    const values = (yield* isRememberedCoworkOfferAvailable(rememberedValues))
      ? rememberedValues
      : queryValues;
    return { ...values, bookingPasses };
  }),
  // Every price and the initial availability render with the content, so no
  // option streams in later and resizes the form.
  preload: (values, { locale, submittedCode, today }) => ({
    advertisedPrices: getCoworkDateAdvertisedPriceRequests({
      date: values.date,
      locale,
      submittedCode,
    }),
    availability: Object.values(
      getCoworkAvailabilityQueries({ ...values, today })
    ),
  }),
  offerings: (values, advertisedPrices, { locale, submittedCode }) =>
    getCoworkPageOfferings({
      advertisedPrices,
      coffee: Boolean(values.coffee),
      date: values.date,
      locale,
      submittedCode,
    }),
  renderForm: ({
    initialValues: { bookingPasses, initialEntryPack, ...initialValues },
    ...form
  }) => (
    <CoworkReservationForm
      bookingPasses={bookingPasses}
      checkoutCustomer={form.checkoutCustomer}
      checkoutSessionId={form.checkoutSessionId}
      entryPackOffered={form.pageData.entryPackOffered}
      initialAdvertisedPrices={form.initialAdvertisedPrices}
      initialAvailability={form.initialAvailability}
      initialEntryPack={initialEntryPack}
      initialValues={initialValues}
      locale={form.locale}
      overnightStayOffered={form.pageData.overnightStayOffered}
      replacementToken={form.replacementToken}
      submittedCode={form.submittedCode}
      today={form.today}
    />
  ),
});

export function CoworkOfferReplaced({ locale }: { readonly locale: Locale }) {
  return (
    <Card className="relative overflow-hidden rounded-4xl border-white/55 bg-white/94 text-navy-blue shadow-[0_44px_140px_-54px_rgba(0,2,79,0.62)] backdrop-blur-sm">
      <CardHeader className="space-y-3 pb-6">
        <CardTitle as="h2" className="text-3xl sm:text-[2.35rem]">
          {m.reservationValidationCoworkOfferReplaced({}, { locale })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Button asChild size="xl" caps fullWidth>
          <a href={getCoworkReservationPath(locale)}>
            {m.checkoutPayRestartButton({}, { locale })}
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
