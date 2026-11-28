import { Effect, Layer, Schema } from "effect";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache, Suspense } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { getAccountSignInPath } from "@/features/account/routes";
import { getDiscountCodeEntryEnabled } from "@/features/discounts/discount-code-entry.server";
import { type Locale, m } from "@/features/i18n";
import { runWithRequestLocale } from "@/features/i18n/server/request-locale";
import { type OrderId, orderIdSchema } from "@/features/order";
import { isCoworkPassesPageOpenAfterConnection } from "@/features/passes/backend/cowork-passes-release-gate.server";
import { readOwnedPassPurchaseOrderLocale } from "@/features/passes/backend/entry-pack-order";
import { readPassCheckoutHandoffForPage } from "@/features/passes/backend/pass-checkout-handoff";
import { readPassPurchaseBuyer } from "@/features/passes/backend/pass-purchase-buyer";
import {
  loadUnlimitedCheckoutContinuation,
  readUnlimitedCheckoutRenewal,
} from "@/features/passes/backend/unlimited-pass-purchase";
import { UnlimitedPassCheckout } from "@/features/passes/components/unlimited-pass-checkout";
import { passCheckoutHandoffTokenSchema } from "@/features/passes/entry-pack-checkout";
import { unlimitedPassDays } from "@/features/passes/pass-offer";
import {
  getPassCheckoutHandoffPath,
  getUnlimitedRenewalPath,
  withPassCheckoutHandoff,
} from "@/features/passes/routes";
import {
  beginUnlimitedCheckout,
  getUnlimitedCheckoutAvailability,
  payUnlimitedCheckout,
  repriceUnlimitedCheckout,
} from "@/features/passes/unlimited-checkout-actions";
import {
  getUnlimitedPassChoosePath,
  getUnlimitedPassDetailsPath,
  getUnlimitedPassPayPath,
  readUnlimitedPassSelection,
  type UnlimitedPassOrderLink,
  unlimitedCheckoutPredecessorLimit,
} from "@/features/passes/unlimited-pass-checkout";
import { createNoindexedPageMetadata } from "@/features/public-pages/page-metadata";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { reservationStatusPath } from "@/features/reservation/routes";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";
import { SealedStateKeys } from "@/shared/backend/sealed-state-keys.service";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import { QueryProvider } from "@/shared/components/query-provider";
import { formatCount } from "@/shared/utils/number";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";

export const instant = false;
export const maxDuration = 240;

type Query = Parameters<typeof readUnlimitedPassSelection>[0] & {
  readonly step?: string | string[];
  readonly order?: string | string[];
  readonly submittedOrder?: string | string[];
  readonly supersedeOrder?: string | string[];
  readonly predecessorOrder?: string | string[];
  readonly legacyPredecessorOrder?: string | string[];
  readonly predecessorMode?: string | string[];
  readonly renew?: string | string[];
  readonly handoff?: string | string[];
};

const customerServices = Layer.mergeAll(
  WorkspaceDatabase.Default,
  CurrentCustomerAccount.Live,
  CustomerAccountContactService.Live
);

const workspaceDate = (instant: Temporal.Instant) =>
  plainDateStringSchema.make(getCurrentWorkspaceDate(instant).toString());

const readContinuation = cache(
  (orderId: OrderId, mode: "draft" | "submitted" | "payment") =>
    loadUnlimitedCheckoutContinuation(orderId, mode).pipe(
      Effect.provide(customerServices),
      runWorkspaceEffectOrElse("passes.unlimited-checkout-continuation", {
        failureCode: "unlimited_checkout_unavailable",
        orElse: () => undefined,
      })
    )
);

const readOwnedLocale = cache((orderId: OrderId) =>
  readOwnedPassPurchaseOrderLocale(orderId, "unlimited").pipe(
    Effect.provide(customerServices),
    runWorkspaceEffectOrElse("passes.unlimited-checkout-order-locale", {
      failureCode: "unlimited_checkout_unavailable",
      orElse: () => undefined,
    })
  )
);

const readRenewal = (passId: OrderId, resumePending: boolean) =>
  readUnlimitedCheckoutRenewal(passId, resumePending).pipe(
    Effect.provide(customerServices),
    runWorkspaceEffectOrElse("passes.unlimited-checkout-renewal", {
      failureCode: "unlimited_checkout_unavailable",
      orElse: () => undefined,
    })
  );

async function leaveUnavailableOrder(orderId: OrderId): Promise<never> {
  const locale = await readOwnedLocale(orderId);
  if (locale) redirect(`/${locale}${reservationStatusPath}/${orderId}`);
  notFound();
}

function readOrderLink(query: Query): UnlimitedPassOrderLink | undefined {
  if (
    query.submittedOrder !== undefined ||
    query.predecessorOrder !== undefined ||
    query.legacyPredecessorOrder !== undefined ||
    query.predecessorMode !== undefined
  ) {
    const {
      submittedOrder,
      predecessorOrder,
      legacyPredecessorOrder,
      predecessorMode,
      supersedeOrder,
    } = query;
    const ids = [predecessorOrder ?? []].flat();
    const legacyIds = [legacyPredecessorOrder ?? []].flat();
    const isOrderId = Schema.is(orderIdSchema);
    if (
      query.order !== undefined ||
      (query.step !== undefined && query.step !== "details") ||
      (predecessorMode !== undefined &&
        (ids.length === 0 || predecessorMode !== "history")) ||
      ids.length > unlimitedCheckoutPredecessorLimit ||
      legacyIds.length > ids.length ||
      !ids.every(isOrderId) ||
      !legacyIds.every(isOrderId)
    )
      notFound();
    const predecessorOrderIds = [
      ...new Set(ids.map((id) => orderIdSchema.make(id.toLowerCase()))),
    ];
    let supersedeOrderId: OrderId | undefined;
    if (supersedeOrder !== undefined) {
      if (!isOrderId(supersedeOrder)) notFound();
      supersedeOrderId = orderIdSchema.make(supersedeOrder.toLowerCase());
      if (!predecessorOrderIds.includes(supersedeOrderId)) notFound();
    }
    // Shipped links used the same list for edits and leftover cleanup history.
    const legacyPredecessorOrderIds =
      legacyPredecessorOrder === undefined &&
      predecessorMode === undefined &&
      !supersedeOrderId
        ? predecessorOrderIds
        : [
            ...new Set(
              legacyIds.map((id) => orderIdSchema.make(id.toLowerCase()))
            ),
          ];
    if (
      !legacyPredecessorOrderIds.every((id) => predecessorOrderIds.includes(id))
    )
      notFound();
    const predecessors = {
      predecessorOrderIds,
      ...(supersedeOrderId && { supersedeOrderId }),
      ...(legacyPredecessorOrderIds.length > 0 && {
        legacyPredecessorOrderIds,
      }),
    };
    if (submittedOrder === undefined) return { kind: "edit", ...predecessors };
    if (!isOrderId(submittedOrder)) notFound();
    const orderId = orderIdSchema.make(submittedOrder.toLowerCase());
    if (predecessorOrderIds.includes(orderId)) notFound();
    return { kind: "submitted", orderId, ...predecessors };
  }
  if (query.order !== undefined && query.supersedeOrder !== undefined)
    notFound();
  if (query.supersedeOrder !== undefined && query.step === "pay") notFound();
  const orderId = query.order ?? query.supersedeOrder;
  if (orderId === undefined) return undefined;
  if (!Schema.is(orderIdSchema)(orderId)) notFound();
  return {
    kind: query.order !== undefined ? "resume" : "replace",
    orderId: orderIdSchema.make(orderId.toLowerCase()),
  };
}

async function requirePageOpen(searchParams: Promise<Query>) {
  if (await isCoworkPassesPageOpenAfterConnection()) return;
  const order = readOrderLink(await searchParams);
  const orderId =
    order?.kind === "edit" ? order.predecessorOrderIds[0] : order?.orderId;
  if (orderId) await leaveUnavailableOrder(orderId);
  notFound();
}

export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}): Promise<Metadata> {
  return runWithRequestLocale(async (locale) => {
    await requirePageOpen(searchParams);
    return createNoindexedPageMetadata({
      locale,
      title: { page: m.unlimitedPassCheckoutTitle({}, { locale }) },
      description: m.unlimitedPassCheckoutMetadataDescription(
        { days: formatCount(unlimitedPassDays, locale) },
        { locale }
      ),
    });
  });
}

export default async function UnlimitedPassPage({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}) {
  return runWithRequestLocale(async (locale) => {
    await requirePageOpen(searchParams);
    return (
      <Suspense fallback={null}>
        <UnlimitedPassPageContent searchParams={searchParams} locale={locale} />
      </Suspense>
    );
  });
}

async function UnlimitedPassPageContent({
  searchParams,
  locale,
}: {
  readonly searchParams: Promise<Query>;
  readonly locale: Locale;
}) {
  const query = await searchParams;
  const order = readOrderLink(query);
  const handoffToken = Schema.is(passCheckoutHandoffTokenSchema)(query.handoff)
    ? query.handoff
    : undefined;
  if (
    query.handoff !== undefined &&
    (!handoffToken ||
      order !== undefined ||
      query.renew !== undefined ||
      (query.step !== undefined && query.step !== "details"))
  ) {
    notFound();
  }
  if (query.renew !== undefined && !Schema.is(orderIdSchema)(query.renew))
    notFound();
  const requestedRenewal = query.renew;
  const orderId = order?.kind === "edit" ? undefined : order?.orderId;
  const isPaymentStep = order?.kind === "resume" && query.step === "pay";
  const continuationMode = order?.kind === "submitted" ? "submitted" : "draft";
  const { options, startDate } = readUnlimitedPassSelection(query);
  const requestedSelection = startDate && { ...options, startDate };
  if (order?.kind === "submitted" && !requestedSelection && !requestedRenewal)
    notFound();
  const checkoutPath = (
    targetLocale: Locale,
    selection: typeof requestedSelection = requestedSelection,
    renewsPassId = requestedRenewal
  ) => {
    if (isPaymentStep && orderId)
      return getUnlimitedPassPayPath(targetLocale, orderId);
    if (query.step === "details" && selection) {
      return getUnlimitedPassDetailsPath(
        targetLocale,
        selection,
        order,
        renewsPassId
      );
    }
    if (renewsPassId && !order && query.tier === undefined)
      return getUnlimitedRenewalPath(targetLocale, renewsPassId);
    return getUnlimitedPassChoosePath(
      targetLocale,
      selection ?? options,
      selection?.startDate,
      order,
      renewsPassId
    );
  };
  const [checkout, continuation] = await Promise.all([
    Effect.gen(function* () {
      const checkout = yield* Effect.all({
        buyer: readPassPurchaseBuyer(),
        today: currentInstant.pipe(Effect.map(workspaceDate)),
        discountCodeEntryEnabled: getDiscountCodeEntryEnabled.pipe(
          Effect.orElseSucceed(() => false)
        ),
      });
      const handoff =
        handoffToken && checkout.buyer.kind !== "signed-out"
          ? yield* readPassCheckoutHandoffForPage(
              handoffToken,
              "unlimited"
            ).pipe(Effect.provide(SealedStateKeys.Default))
          : undefined;
      return { ...checkout, handoff };
    }).pipe(
      Effect.provide(customerServices),
      runWorkspaceEffectOrElse("passes.unlimited-checkout-page", {
        failureCode: "unlimited_checkout_unavailable",
        orElse: () => ({
          buyer: { kind: "unavailable" as const },
          today: workspaceDate(Temporal.Now.instant()),
          discountCodeEntryEnabled: false,
          handoff: undefined,
        }),
      })
    ),
    orderId &&
      readContinuation(orderId, isPaymentStep ? "payment" : continuationMode),
  ]);
  const { handoff } = checkout;
  if (handoffToken !== undefined) {
    if (checkout.buyer.kind === "signed-out") {
      redirect(
        getAccountSignInPath(
          locale,
          query.tier === undefined
            ? getPassCheckoutHandoffPath(locale, "unlimited", handoffToken)
            : withPassCheckoutHandoff(checkoutPath(locale), handoffToken)
        )
      );
    }
    if (handoff?.product.kind !== "unlimited") notFound();
    if (handoff.statusPath) redirect(handoff.statusPath);
  }
  if ((order || requestedRenewal) && checkout.buyer.kind === "signed-out") {
    redirect(getAccountSignInPath(locale, checkoutPath(locale)));
  }
  if (orderId) {
    if (continuation?.kind === "status") {
      redirect(`/${continuation.locale}${reservationStatusPath}/${orderId}`);
    }
    if (!continuation && order?.kind !== "submitted") notFound();
  }

  const draft = continuation?.kind !== "status" ? continuation : undefined;
  const resumesDraft = order?.kind === "resume" || order?.kind === "submitted";
  if (
    draft &&
    resumesDraft &&
    requestedRenewal &&
    requestedRenewal !== draft.renewsPassId
  )
    notFound();
  const renewsPassId =
    (resumesDraft && draft ? draft.renewsPassId : requestedRenewal) ??
    undefined;
  const renewal =
    renewsPassId && (!resumesDraft || !draft)
      ? await readRenewal(renewsPassId, !order && query.tier === undefined)
      : undefined;
  if (renewsPassId && (!resumesDraft || !draft) && !renewal) notFound();
  if (renewal?.pendingOrderId) {
    redirect(
      getUnlimitedPassDetailsPath(
        locale,
        renewal.selection,
        {
          kind: "resume",
          orderId: renewal.pendingOrderId,
        },
        renewsPassId
      )
    );
  }

  const renewalSelection = renewal && {
    ...(query.tier === undefined ? renewal.selection : options),
    startDate: renewal.selection.startDate,
  };
  const draftSelection = resumesDraft ? draft?.selection : undefined;
  const selection =
    handoff?.product.kind === "unlimited" && query.tier === undefined
      ? handoff.product.selection
      : (draftSelection ?? renewalSelection ?? requestedSelection);
  const checkoutDraft =
    order && draft
      ? { ...order, holderEmail: draft.holderEmail ?? null }
      : order;
  const handoffDraft = handoff
    ? {
        kind: "resume" as const,
        orderId: handoff.orderId,
        holderEmail: handoff.holderEmail ?? null,
      }
    : undefined;
  const initialPayment = draft?.kind === "pay" ? draft.payment : undefined;
  if (
    orderId &&
    draft?.kind === "pay" &&
    !initialPayment?.priorPaymentAttemptId &&
    checkout.buyer.kind === "profile-required"
  ) {
    redirect(
      getUnlimitedPassDetailsPath(
        draft.locale,
        draft.selection,
        { kind: "resume", orderId },
        renewsPassId
      )
    );
  }
  if (draft && draft.locale !== locale) {
    redirect(checkoutPath(draft.locale, selection, renewsPassId));
  }

  const { today } = checkout;

  return (
    <QueryProvider>
      <UnlimitedPassCheckout
        locale={locale}
        buyer={checkout.buyer}
        discountCodeEntryEnabled={checkout.discountCodeEntryEnabled}
        initialOptions={selection ?? options}
        initialStartDate={selection?.startDate}
        initialDetails={query.step === "details" ? selection : undefined}
        {...(handoff &&
          handoffToken && {
            initialHandoff: {
              token: handoffToken,
              orderId: handoff.orderId,
              predecessorOrderIds: handoff.predecessorOrderIds ?? [],
            },
          })}
        renewsPassId={renewsPassId}
        initialBounds={{
          today,
          lastStartDate: plainDateStringSchema.make(
            getWorkspaceAvailabilityRange(today).to
          ),
        }}
        draft={handoffDraft ?? checkoutDraft}
        initialPayment={
          orderId && draft && initialPayment
            ? {
                orderId,
                selection: draft.selection,
                state: {
                  ...initialPayment,
                  holderEmail: draft.holderEmail,
                },
              }
            : undefined
        }
        getAvailability={getUnlimitedCheckoutAvailability}
        beginCheckout={beginUnlimitedCheckout}
        repriceCheckout={repriceUnlimitedCheckout}
        payCheckout={payUnlimitedCheckout}
      />
    </QueryProvider>
  );
}
