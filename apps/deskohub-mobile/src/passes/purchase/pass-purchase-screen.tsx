import type {
  BeginCustomerPassPurchase,
  CustomerAccountState,
  CustomerPassCatalog,
  CustomerPassPurchase,
  SubmitCustomerPassPurchase,
} from "@deskohub/workspace-customer-api";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option, Predicate } from "effect";
import { AsyncResult } from "effect/reactivity";
import * as Crypto from "expo-crypto";
import {
  Stack,
  useFocusEffect,
  useIsFocused,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import CreditCard from "lucide-react-native/icons/credit-card";
import { useCallback, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { initialsOf } from "../../account/account-root-model";
import { checkoutReturnTarget } from "../../booking/checkout/checkout-commands";
import { detailsDraftAtom } from "../../booking/checkout-screen/details-draft";
import {
  type DetailsProfile,
  detailsAccess,
  initialDetailsDraft,
} from "../../booking/checkout-screen/details-form";
import { usePaymentBrowserWarmUp } from "../../booking/payment-browser";
import { addDays } from "../../booking/selection/prague-date";
import {
  BookingBar,
  type BookingBarSummary,
} from "../../booking/ui/booking-bar";
import { type BookingStep, BookingSteps } from "../../booking/ui/booking-steps";
import {
  accountAtom,
  customerDataRuntime,
} from "../../customer-api/customer-data-runtime";
import type { AppLocale } from "../../i18n/app-locale";
import { useDeviceCountry } from "../../i18n/device-locale";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";
import { AppBar } from "../../ui/app-bar";
import { ErrorState, LoadingState } from "../../ui/async-states";
import { FocusedStatusBar } from "../../ui/focused-status-bar";
import { Notice } from "../../ui/notice";
import { ScrollScreen } from "../../ui/scroll-screen";
import { color, space } from "../../ui/tokens";
import { QuietUpdateOffer } from "../../updates/update-offer-card";
import { passCatalogAtom } from "../pass-reads";
import { PassChoose } from "./choose/pass-choose";
import { hasPassLegalDocuments } from "./pass-purchase-agreement";
import {
  PassPurchaseDetails,
  type PurchaseDetails,
  type PurchaseDetailsProblems,
  validatePurchaseDetails,
} from "./pass-purchase-details";
import {
  beginPassPurchaseAtom,
  openPassPaymentAtom,
  passPaymentPayload,
  passPurchaseStatusHref,
  submitPassPurchaseAtom,
  unlimitedStartDatesAtom,
  updatePassPurchasePriceAtom,
} from "./pass-purchase-requests";
import {
  PassPurchaseReview,
  passEntryLabel,
  passPeriodLabel,
  passTierTitle,
  passTitle,
} from "./pass-purchase-review";
import {
  advertisedPassPrice,
  initializePassSelection,
  type PassPurchaseSelection,
  type PurchaseKind,
  readPassPurchasePrefill,
  selectedPassProduct,
} from "./pass-purchase-selection";
import { readPassPurchaseStatus } from "./status/pass-purchase-status-state";

const reconcilePassOrder = customerDataRuntime.fn(
  ({ orderId, locale }: { orderId: string; locale: AppLocale }) =>
    readPassPurchaseStatus(orderId, locale)
);

type PurchaseBilling = NonNullable<SubmitCustomerPassPurchase["billing"]>;

type PurchaseQuote = {
  readonly quote: CustomerPassPurchase;
  readonly billing: PurchaseBilling;
};

type Attempt = {
  readonly input: BeginCustomerPassPurchase;
  readonly billing: PurchaseBilling;
  readonly unconfirmed: boolean;
};

const errorOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;

const purchaseRefusal = (error: unknown) =>
  Predicate.isTagged(error, "CustomerPassPurchaseRefused") &&
  Predicate.hasProperty(error, "reason")
    ? error.reason
    : undefined;

const needsStatus = (error: unknown) =>
  Predicate.isTagged(error, "CustomerWriteUnconfirmed") ||
  purchaseRefusal(error) === "payment-in-progress" ||
  purchaseRefusal(error) === "billing-changed";

export function PassPurchaseScreen({ kind }: { readonly kind: PurchaseKind }) {
  const locale = useAppLocale();
  const params = useLocalSearchParams();
  const prefill = readPassPurchasePrefill(kind, params);
  const account = useAtomValue(accountAtom);
  const catalog = useAtomValue(passCatalogAtom);
  const refreshAccount = useAtomRefresh(accountAtom);
  const refreshCatalog = useAtomRefresh(passCatalogAtom);

  if (!AsyncResult.isSuccess(catalog) || !AsyncResult.isSuccess(account)) {
    return (
      <>
        <Stack.Screen options={{ title: passTitle(kind, locale) }} />
        <ScrollScreen contentWidth="wide">
          {AsyncResult.isFailure(catalog) || AsyncResult.isFailure(account) ? (
            <ErrorState
              message={m.pass_purchase_unavailable({}, { locale })}
              retryLabel={m.booking_checkout_retry({}, { locale })}
              onRetry={() => {
                refreshAccount();
                refreshCatalog();
              }}
            />
          ) : (
            <LoadingState label={m.pass_purchase_loading({}, { locale })} />
          )}
        </ScrollScreen>
      </>
    );
  }

  const access = detailsAccess(account.value);
  if (access._tag === "Unavailable") {
    return (
      <ScrollScreen contentWidth="wide">
        <Stack.Screen options={{ title: passTitle(kind, locale) }} />
        <ErrorState
          message={m.booking_checkout_blocked_account_unavailable(
            {},
            { locale }
          )}
          retryLabel={m.booking_checkout_retry({}, { locale })}
          onRetry={refreshAccount}
        />
      </ScrollScreen>
    );
  }
  return (
    <PassPurchaseFlow
      profile={access}
      key={JSON.stringify(prefill)}
      kind={kind}
      prefill={prefill}
      account={account.value}
      catalog={catalog.value}
      locale={locale}
    />
  );
}

function PassPurchaseFlow({
  kind,
  prefill,
  account,
  profile,
  catalog,
  locale,
}: {
  readonly kind: PurchaseKind;
  readonly prefill: PassPurchaseSelection;
  readonly account: CustomerAccountState;
  readonly profile: DetailsProfile;
  readonly catalog: CustomerPassCatalog;
  readonly locale: AppLocale;
}) {
  const country = useDeviceCountry();
  const priorDetails = useAtomValue(detailsDraftAtom);
  const [details, setDetails] = useState<PurchaseDetails>(() => {
    const invoice = initialDetailsDraft(profile.saved, country);
    const previous = Option.getOrUndefined(priorDetails);
    const [firstName = "", ...lastName] =
      previous?.self.name.trim().split(/\s+/) ?? [];
    return {
      invoice:
        previous === undefined
          ? invoice
          : {
              ...invoice,
              billing: previous.billing,
              company: previous.company,
              personalAddress: previous.personalAddress,
            },
      buyer: {
        firstName,
        lastName: lastName.join(" "),
        phone: previous?.self.phone ?? "",
      },
      gift: false,
      holderEmail: "",
      recipientName: "",
    };
  });

  const router = useRouter();
  const [step, setStep] = useState<BookingStep>("choose");
  const [edited, setEdited] = useState<PassPurchaseSelection>();
  const [purchase, setPurchase] = useState<PurchaseQuote>();
  const [previousOrderId, setPreviousOrderId] = useState<string>();
  const [approvedQuote, setApprovedQuote] = useState<CustomerPassPurchase>();
  const [notice, setNotice] = useState<string>();
  const [problems, setProblems] = useState<PurchaseDetailsProblems>({});
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const focused = useRef(false);
  const attempt = useRef<Attempt>(undefined);
  const ownsView = () => focused.current;
  const isFocused = useIsFocused();
  const datesAtom = unlimitedStartDatesAtom(
    kind === "unlimited" && isFocused ? previousOrderId : false
  );
  const datesResult = useAtomValue(datesAtom);
  const dates = AsyncResult.isSuccess(datesResult)
    ? datesResult.value
    : undefined;
  const refreshDates = useAtomRefresh(datesAtom);
  const begin = useAtomSet(beginPassPurchaseAtom, { mode: "promiseExit" });
  const submit = useAtomSet(submitPassPurchaseAtom, { mode: "promiseExit" });
  const openPayment = useAtomSet(openPassPaymentAtom, { mode: "promiseExit" });
  const updatePrice = useAtomSet(updatePassPurchasePriceAtom, {
    mode: "promiseExit",
  });
  const reconcileOrder = useAtomSet(reconcilePassOrder, {
    mode: "promiseExit",
  });
  usePaymentBrowserWarmUp();

  const setStage = useCallback((next: BookingStep) => {
    Keyboard.dismiss();
    setNotice(undefined);
    setStep(next);
  }, []);
  const goBack = useCallback(() => {
    if (working.current) return;
    switch (step) {
      case "choose":
        if (router.canGoBack()) router.back();
        else router.replace("/book");
        break;
      case "details":
        setStage("choose");
        break;
      case "pay":
        setStage("details");
        break;
    }
  }, [router, setStage, step]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, [])
  );
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          if (step === "choose" && !working.current && router.canGoBack()) {
            return false;
          }
          goBack();
          return true;
        }
      );
      return () => subscription.remove();
    }, [goBack, router, step])
  );

  const name = Option.getOrUndefined(profile.self.name);
  const needsProfile = account.kind !== "linked";
  const choice =
    edited ?? initializePassSelection(kind, prefill, catalog, dates);
  const product = selectedPassProduct(kind, choice, catalog, dates);
  const updateSelection = (patch: Partial<PassPurchaseSelection>) => {
    if (attempt.current?.unconfirmed) return;
    setEdited({ ...choice, ...patch });
    setNotice(undefined);
  };
  const updateDetails = (next: PurchaseDetails) => {
    if (attempt.current?.unconfirmed) return;
    setDetails(next);
    setNotice(undefined);
    setProblems({});
  };
  const showStatus = (orderId: string) => {
    if (focused.current) router.replace(passPurchaseStatusHref(orderId));
  };
  const runAction = async (action: () => Promise<void>) => {
    if (working.current || !ownsView()) return;
    working.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const prepareAttempt = (): Attempt | undefined => {
    const current = attempt.current;
    if (current?.unconfirmed) return current;
    if (product === undefined) {
      setStage("choose");
      refreshDates();
      setNotice(m.booking_cowork_offer_unavailable({}, { locale }));
      return;
    }
    const validated = validatePurchaseDetails(
      kind,
      details,
      profile,
      needsProfile
    );
    if (!validated.ok) {
      setProblems(validated.problems);
      return;
    }
    const content = { locale, product, ...validated.input };
    const input =
      current !== undefined &&
      JSON.stringify(content) ===
        JSON.stringify(purchaseInputContent(current.input))
        ? current.input
        : {
            ...content,
            orderId: Crypto.randomUUID(),
            ...(kind === "unlimited" &&
              previousOrderId !== undefined && {
                supersedeOrderId: previousOrderId,
              }),
          };
    return { input, billing: validated.billing, unconfirmed: false };
  };

  const prepare = async () => {
    const pending = prepareAttempt();
    if (pending === undefined) return;
    attempt.current = pending;
    const { input, billing } = pending;
    const exit = await begin({ payload: input, owns: ownsView });
    if (Exit.isSuccess(exit)) {
      attempt.current = { ...pending, unconfirmed: false };
      if (kind === "unlimited") setPreviousOrderId(exit.value.orderId);
      if (!ownsView()) return;
      setPurchase({ quote: exit.value, billing });
      setApprovedQuote(undefined);
      setStage("pay");
      return;
    }
    const error = errorOf(exit);
    const reason = purchaseRefusal(error);
    const holdsUnavailable = reason === "holds-unavailable";
    const ambiguousHold =
      holdsUnavailable &&
      !(
        Predicate.hasProperty(error, "blockingDates") &&
        Array.isArray(error.blockingDates)
      );
    if (
      Predicate.isTagged(error, "CustomerWriteUnconfirmed") ||
      ambiguousHold ||
      reason === "payment-in-progress"
    ) {
      attempt.current = { ...pending, unconfirmed: true };
    } else if (
      holdsUnavailable ||
      reason === "quote-expired" ||
      reason === "invalid-selection"
    ) {
      attempt.current = undefined;
    }

    if (!ownsView()) return;
    if (reason === "payment-in-progress") {
      const orderId =
        Predicate.hasProperty(error, "orderId") &&
        typeof error.orderId === "string"
          ? error.orderId
          : input.orderId;
      showStatus(orderId);
      return;
    }
    if (ambiguousHold) {
      // A bare hold refusal does not tell us whether the old order is live.
      const status = await reconcileOrder({ orderId: input.orderId, locale });
      if (!ownsView()) return;
      if (Exit.isSuccess(status)) {
        showStatus(status.value.orderId);
        return;
      }
      if (!Predicate.isTagged(errorOf(status), "CustomerPassNotFound")) {
        setNotice(m.booking_checkout_unconfirmed({}, { locale }));
        return;
      }
      attempt.current = undefined;
    }
    if (holdsUnavailable || reason === "invalid-selection") {
      setStage("choose");
      refreshDates();
    }
    setNotice(purchaseErrorMessage(error, locale));
  };

  const changeCode = async (submittedCode: string | undefined) => {
    if (purchase === undefined) return;
    const { quote } = purchase;
    setApprovedQuote(undefined);
    setNotice(undefined);
    const exit = await updatePrice({
      orderId: quote.orderId,
      owns: ownsView,
      payload: {
        productKind: quote.product.kind,
        displayedPriceFingerprint: quote.price.fingerprint,
        ...(submittedCode === undefined ? {} : { submittedCode }),
      },
    });
    if (!focused.current) return;
    if (Exit.isFailure(exit)) {
      const error = errorOf(exit);
      if (purchaseRefusal(error) === "payment-in-progress") {
        showStatus(quote.orderId);
        return;
      }
      setNotice(purchaseErrorMessage(error, locale));
      return;
    }
    if (exit.value.status === "code_unavailable") {
      setNotice(m.booking_checkout_code_unavailable({}, { locale }));
      return;
    }
    setPurchase({ ...purchase, quote: { ...quote, price: exit.value.price } });
    if (exit.value.status === "pricing_changed") {
      setNotice(m.booking_checkout_price_changed({}, { locale }));
    }
  };

  const accepted = purchase !== undefined && approvedQuote === purchase.quote;
  const pay = async () => {
    if (
      purchase === undefined ||
      !accepted ||
      !hasPassLegalDocuments(purchase.quote.disclosure)
    )
      return;
    const { quote, billing } = purchase;
    const exit = await submit({
      orderId: quote.orderId,
      owns: ownsView,
      payload: passPaymentPayload(
        quote,
        billing,
        checkoutReturnTarget(Platform.OS)
      ),
    });
    if (!focused.current) return;
    if (Exit.isFailure(exit)) {
      const error = errorOf(exit);
      if (needsStatus(error)) {
        showStatus(quote.orderId);
        return;
      }
      if (purchaseRefusal(error) === "quote-expired") {
        attempt.current = undefined;
        setStage("details");
      }
      setApprovedQuote(undefined);
      setNotice(purchaseErrorMessage(error, locale));
      return;
    }
    switch (exit.value.status) {
      case "pricing_changed":
        setPurchase({
          ...purchase,
          quote: { ...quote, price: exit.value.price },
        });
        setApprovedQuote(undefined);
        setNotice(m.booking_checkout_price_changed({}, { locale }));
        return;
      case "terms_changed":
        setPurchase({
          ...purchase,
          quote: { ...quote, disclosure: exit.value.disclosure },
        });
        setApprovedQuote(undefined);
        setNotice(m.booking_checkout_legal_changed({}, { locale }));
        return;
      case "hosted":
        await openPayment({
          orderId: quote.orderId,
          redirectUrl: exit.value.redirectUrl,
          owns: ownsView,
        });
        showStatus(quote.orderId);
        return;
      case "paid":
      case "pending":
        showStatus(quote.orderId);
    }
  };

  const title = passTitle(kind, locale);
  const tier = passTierTitle(choice.tier, locale);
  const currentQuote = step === "pay" ? purchase?.quote : undefined;
  const total =
    currentQuote?.price.total ?? advertisedPassPrice(kind, choice, catalog);
  const selectedStart = currentQuote?.validFrom ?? choice.startDate;
  const validityDays = catalog.unlimited.find(
    ({ product: offer }) => offer.tier === choice.tier
  )?.validityDays;
  const lastDate =
    currentQuote?.lastUsableDate ??
    (selectedStart !== undefined && validityDays !== undefined
      ? addDays(selectedStart, validityDays - 1)
      : undefined);
  const periodTitle =
    selectedStart !== undefined && lastDate !== undefined
      ? passPeriodLabel(selectedStart, lastDate, locale)
      : title;
  const summary: BookingBarSummary = {
    title:
      kind === "entry-pack"
        ? m.pass_purchase_product_summary(
            { title, units: passEntryLabel(choice.size, locale) },
            { locale }
          )
        : periodTitle,
    detail:
      kind === "entry-pack"
        ? tier
        : m.pass_purchase_product_summary({ title, units: tier }, { locale }),
    price:
      total === undefined ? { kind: "none" } : { kind: "from", amount: total },
  };
  const action = {
    choose: {
      label: m.booking_continue({}, { locale }),
      disabled: product === undefined && !attempt.current?.unconfirmed,
      onPress: () => {
        setEdited(choice);
        setStage("details");
      },
    },
    details: {
      label: m.booking_details_continue({}, { locale }),
      busy,
      onPress: () => void runAction(prepare),
    },
    pay: {
      label:
        total === undefined
          ? m.booking_steps_pay({}, { locale })
          : m.booking_checkout_pay(
              { amount: formatMoney(total, locale) },
              { locale }
            ),
      disabled:
        !accepted ||
        currentQuote === undefined ||
        !hasPassLegalDocuments(currentQuote.disclosure),
      busy,
      icon: CreditCard,
      onPress: () => void runAction(pay),
    },
  }[step];

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          headerShown: false,
          gestureEnabled: step === "choose" && !busy,
        }}
      />
      <SafeAreaView edges={["top", "left", "right"]}>
        <FocusedStatusBar style="dark" />
        <AppBar title={title} onBack={goBack} alignToContent />
      </SafeAreaView>
      <BookingSteps current={step} locale={locale} contentWidth="wide" />
      <ScrollScreen key={step} contentWidth="wide">
        <QuietUpdateOffer backdrop="paper" />
        <View style={styles.body}>
          <Notice
            tone="warning"
            message={
              notice ??
              (step === "details" && attempt.current?.unconfirmed
                ? m.booking_checkout_unconfirmed({}, { locale })
                : undefined)
            }
          />
          {step === "choose" && (
            <>
              <PassChoose
                kind={kind}
                catalog={catalog}
                selection={choice}
                datesFailed={AsyncResult.isFailure(datesResult)}
                {...(dates && { dates })}
                locale={locale}
                onChange={updateSelection}
              />
              {AsyncResult.isFailure(datesResult) && (
                <ErrorState
                  message={m.pass_purchase_unavailable({}, { locale })}
                  retryLabel={m.booking_checkout_retry({}, { locale })}
                  onRetry={refreshDates}
                />
              )}
            </>
          )}
          {step === "details" && (
            <PassPurchaseDetails
              kind={kind}
              profile={profile}
              name={name}
              initials={
                account.kind === "linked"
                  ? initialsOf(account.profile)
                  : undefined
              }
              needsProfile={needsProfile}
              details={details}
              onChange={updateDetails}
              problems={problems}
              busy={busy || attempt.current?.unconfirmed === true}
              locale={locale}
            />
          )}
          {step === "pay" && purchase !== undefined && (
            <PassPurchaseReview
              quote={purchase.quote}
              recipient={details.gift ? details.holderEmail.trim() : undefined}
              buyer={
                name ??
                ([details.buyer.firstName, details.buyer.lastName]
                  .filter(Boolean)
                  .join(" ") ||
                  profile.self.email)
              }
              checked={accepted}
              busy={busy}
              onToggle={() =>
                setApprovedQuote(accepted ? undefined : purchase.quote)
              }
              onChange={() => setStage("choose")}
              onCode={(code) => void runAction(() => changeCode(code))}
              locale={locale}
            />
          )}
        </View>
      </ScrollScreen>
      <BookingBar
        locale={locale}
        summary={summary}
        action={action}
        reason={
          step === "pay" && !accepted
            ? m.booking_checkout_consent_required({}, { locale })
            : undefined
        }
      />
    </KeyboardAvoidingView>
  );
}

const purchaseInputContent = ({
  orderId: _orderId,
  supersedeOrderId: _supersedeOrderId,
  ...content
}: BeginCustomerPassPurchase) => content;

const purchaseErrorMessage = (error: unknown, locale: AppLocale) => {
  if (Predicate.isTagged(error, "CustomerWriteUnconfirmed")) {
    return m.booking_checkout_unconfirmed({}, { locale });
  }
  switch (purchaseRefusal(error)) {
    case "holder-unavailable":
      return m.pass_purchase_holder_invalid({}, { locale });
    case "buyer-profile-required":
      return m.pass_purchase_profile_invalid({}, { locale });
    case "holds-unavailable":
    case "invalid-selection":
      return m.booking_cowork_offer_unavailable({}, { locale });
    case "consent-required":
      return m.booking_checkout_consent_required({}, { locale });
    case "quote-expired":
      return m.pass_purchase_quote_expired({}, { locale });
    case "billing-changed":
      return m.pass_purchase_billing_changed({}, { locale });
    default:
      return m.booking_checkout_retry_service_unavailable({}, { locale });
  }
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  body: { gap: space.md },
});
