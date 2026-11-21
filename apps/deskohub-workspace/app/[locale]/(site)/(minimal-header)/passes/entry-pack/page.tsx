import { Effect, Layer, Schema } from "effect";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache, Suspense } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import { getAccountSignInPath } from "@/features/account/routes";
import { AccountingDocumentSnapshots } from "@/features/accounting/backend/accounting-document-snapshots";
import { AccountingSnapshotKeyService } from "@/features/accounting/backend/accounting-snapshot-key.service";
import { LatePaymentVerificationService } from "@/features/checkout/backend/payment/late-payment-verification.service";
import { getDiscountCodeEntryEnabled } from "@/features/discounts/discount-code-entry.server";
import { type Locale, m } from "@/features/i18n";
import { runWithRequestLocale } from "@/features/i18n/server/request-locale";
import { type OrderId, orderIdSchema } from "@/features/order";
import { isCoworkPassesPageOpenAfterConnection } from "@/features/passes/backend/cowork-passes-release-gate.server";
import { readOwnedPassPurchaseOrderLocale } from "@/features/passes/backend/entry-pack-order";
import {
  displayPassPurchasePrice,
  getEntryPackPaymentDisclosure,
  readEntryPackCheckoutDraft,
  readEntryPackPaymentRetry,
} from "@/features/passes/backend/entry-pack-purchase";
import { EntryPackCheckout } from "@/features/passes/components/entry-pack-checkout";
import {
  type EntryPackBuyer,
  getEntryPackDetailsPath,
  getEntryPackPayPath,
  readEntryPackSelection,
} from "@/features/passes/entry-pack-checkout";
import {
  entryPackOffers,
  getEntryPackLastUsableDate,
  getEntryPackValidity,
} from "@/features/passes/pass-offer";
import { reservationStatusPath } from "@/features/reservation/routes";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import { currentInstant } from "@/shared/utils/temporal";

export const instant = false;

type Query = {
  readonly tier?: string | string[];
  readonly size?: string | string[];
  readonly step?: string | string[];
  readonly order?: string | string[];
};

const readOrderLocale = cache((orderId: OrderId) =>
  readOwnedPassPurchaseOrderLocale(orderId, "entry-pack").pipe(
    Effect.provide(
      Layer.mergeAll(WorkspaceDatabase.Default, CurrentCustomerAccount.Live)
    ),
    runWorkspaceEffectOrElse("passes.entry-pack-order-locale", {
      failureCode: "entry_pack_page_unavailable",
      orElse: () => undefined,
    })
  )
);

const requireEntryPackPageOpen = async (searchParams: Promise<Query>) => {
  if (await isCoworkPassesPageOpenAfterConnection()) return;
  const { order } = await searchParams;
  if (Schema.is(orderIdSchema)(order)) {
    const issuedLocale = await readOrderLocale(order);
    if (issuedLocale)
      redirect(`/${issuedLocale}${reservationStatusPath}/${order}`);
  }
  notFound();
};

export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}): Promise<Metadata> {
  return runWithRequestLocale(async (locale) => {
    await requireEntryPackPageOpen(searchParams);
    return {
      title: m.entryPackCheckoutTitle({}, { locale }),
      robots: { index: false, follow: false },
    };
  });
}

export default async function EntryPackPage({
  searchParams,
}: {
  readonly searchParams: Promise<Query>;
}) {
  return runWithRequestLocale(async (locale) => {
    await requireEntryPackPageOpen(searchParams);
    return (
      <Suspense fallback={null}>
        <EntryPackPageContent locale={locale} searchParams={searchParams} />
      </Suspense>
    );
  });
}

const readBuyer = Effect.fn("readEntryPackBuyer")(function* () {
  const account = yield* CurrentCustomerAccount;
  const standing = yield* account.peek;
  switch (standing.kind) {
    case "signed-out":
    case "unverified":
      return { kind: "signed-out" } satisfies EntryPackBuyer;
    case "unlinked":
      return {
        kind: "profile-required",
        email: standing.session.email,
      } satisfies EntryPackBuyer;
    case "linked": {
      const contacts = yield* CustomerAccountContactService;
      const contact = yield* contacts.linkedContact({
        ...standing.account,
        email: standing.session.email,
      });
      return contact
        ? ({
            kind: "linked",
            name: contact.name,
            email: contact.email,
          } satisfies EntryPackBuyer)
        : ({ kind: "unavailable" } satisfies EntryPackBuyer);
    }
    default:
      return { kind: "unavailable" } satisfies EntryPackBuyer;
  }
});

async function EntryPackPageContent({
  locale,
  searchParams,
}: {
  readonly locale: Locale;
  readonly searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const orderId = Schema.is(orderIdSchema)(query.order)
    ? query.order
    : undefined;
  if (query.order !== undefined && !orderId) notFound();
  const isPaymentRetry = orderId !== undefined && query.step === "pay";
  const { buyer, validity, draft, discountCodeEntryEnabled } =
    await runWorkspaceEffectOrElse("passes.entry-pack-page", {
      failureCode: "entry_pack_page_unavailable",
      orElse: () => ({
        buyer: { kind: "unavailable" } as const,
        validity: {},
        draft: undefined,
        discountCodeEntryEnabled: false,
      }),
    })(
      Effect.gen(function* () {
        const now = yield* currentInstant;
        const buyer = yield* readBuyer();
        const draft =
          orderId &&
          (buyer.kind === "linked" || buyer.kind === "profile-required")
            ? yield* Effect.gen(function* () {
                if (!isPaymentRetry)
                  return yield* readEntryPackCheckoutDraft(orderId);
                return yield* readEntryPackPaymentRetry(orderId).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      AccountingDocumentSnapshots.Default.pipe(
                        Layer.provide(
                          Layer.mergeAll(
                            WorkspaceDatabase.Default,
                            AccountingSnapshotKeyService.Default
                          )
                        )
                      ),
                      LatePaymentVerificationService.Live
                    )
                  )
                );
              }).pipe(
                Effect.catchTag("EntryPackPurchaseError", () =>
                  Effect.succeed({ kind: "missing" as const })
                )
              )
            : undefined;
        const validity = Object.fromEntries(
          entryPackOffers
            .filter(({ product }) => product.tier === "open-space")
            .map(({ product }) => [
              product.size,
              getEntryPackLastUsableDate(
                getEntryPackValidity(now, product.size).validUntil
              ).toString(),
            ])
        );
        const discountCodeEntryEnabled =
          yield* getDiscountCodeEntryEnabled.pipe(
            Effect.orElseSucceed(() => false)
          );
        return { buyer, validity, draft, discountCodeEntryEnabled };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            WorkspaceDatabase.Default,
            CurrentCustomerAccount.Live,
            CustomerAccountContactService.Live
          )
        )
      )
    );
  if (draft?.kind === "missing") notFound();
  if (isPaymentRetry) {
    if (buyer.kind === "signed-out") {
      redirect(
        getAccountSignInPath(locale, getEntryPackPayPath(locale, orderId))
      );
    }
    if (draft?.kind !== "retry") {
      redirect(
        `/${draft?.kind === "status" && "locale" in draft ? draft.locale : locale}${reservationStatusPath}/${orderId}`
      );
    }
    if (draft.locale !== locale)
      redirect(getEntryPackPayPath(draft.locale, orderId));
  }
  if (orderId && draft?.kind === "draft" && draft.locale !== locale) {
    redirect(getEntryPackDetailsPath(draft.locale, draft.product, orderId));
  }
  if (orderId && draft?.kind === "status") {
    redirect(`/${locale}${reservationStatusPath}/${orderId}`);
  }
  const product =
    draft?.kind === "draft" || draft?.kind === "retry"
      ? draft.product
      : readEntryPackSelection(query);

  return (
    <EntryPackCheckout
      locale={locale}
      buyer={buyer}
      initialProduct={product}
      initialStep={query.step === "details" || orderId ? "details" : "choose"}
      continuation={
        orderId && (draft?.kind === "draft" || buyer.kind === "signed-out")
          ? {
              orderId,
              holderEmail:
                draft?.kind === "draft" ? draft.holderEmail : undefined,
              validUntil:
                draft?.kind === "draft"
                  ? getEntryPackLastUsableDate(draft.validUntil).toString()
                  : undefined,
            }
          : undefined
      }
      validity={validity}
      retryPayment={
        orderId && draft?.kind === "retry"
          ? {
              orderId,
              state: {
                status: "ready",
                product: draft.product,
                price: displayPassPurchasePrice(draft.quote),
                validFrom: draft.validFrom.toString(),
                lastUsableDate: getEntryPackLastUsableDate(
                  draft.validUntil
                ).toString(),
                disclosure: getEntryPackPaymentDisclosure(draft.locale),
                priorPaymentAttemptId: draft.priorPaymentAttemptId,
                billing: draft.billing,
                ...(draft.holderEmail && { holderEmail: draft.holderEmail }),
              },
            }
          : undefined
      }
      discountCodeEntryEnabled={discountCodeEntryEnabled}
    />
  );
}
