import {
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
} from "@deskohub/dotypos";
import { NexiOrderIdSchema } from "@deskohub/nexi";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Layer, Schema } from "effect";
import {
  promotionCodes,
  referralCodes,
  type WorkspaceReservationRow,
} from "@/db/schema";
import { makeAccountingDocumentSnapshot } from "@/features/accounting/accounting-document-snapshot";
import { AccountingSnapshotKeyService } from "@/features/accounting/backend/accounting-snapshot-key.service";
import { testAccountingStorage } from "@/features/accounting/backend/accounting-storage.test-utils";
import { buildCoworkReservationQuote } from "@/features/checkout/reservation-quote-cowork";
import { calculateDiscounts } from "@/features/discounts/calculator";
import { makeDiscountCommitment } from "@/features/discounts/commitment";
import {
  canonicalPromotionCodeSchema,
  promotionCodeIdSchema,
} from "@/features/discounts/persistence-contracts";
import type { DiscountCandidate } from "@/features/discounts/provider";
import { type Locale, m } from "@/features/i18n";
import { referralInvitationDiscountBasisPoints } from "@/features/referrals/program";
import { getReferralBenefitIds } from "@/features/referrals/referral-benefits";
import { normalizedCoworkReservationOrderSchema } from "@/features/reservation/cowork-reservation";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import type { WorkspacePostgresTestDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  type IPaymentLifecycleRepository,
  PaymentLifecycleRepository,
} from "./payment-lifecycle.repository";

const product = { kind: "cowork", tier: "basic" } as const;
const reservationDetails = {
  kind: "cowork",
  entryTier: "basic",
  coffee: false,
} as const;
const locale: Locale = "en-US";

export const paymentLifecycleReservationOrder = Schema.decodeUnknownSync(
  normalizedCoworkReservationOrderSchema
)({
  ...reservationDetails,
  date: "2099-01-01",
  name: "Synthetic Customer",
  email: testEmailAddress("synthetic"),
  phone: "+420 700 000 000",
});

export const paymentLifecycleCustomerId = () =>
  DotyposCustomerIdSchema.make(
    (Math.floor(Math.random() * 900_000_000) + 100_000_000).toString()
  );

const makeInvitationCandidate = (referral: {
  readonly invitedDotyposCustomerId: DotyposCustomerId;
  readonly referrerDotyposCustomerId: DotyposCustomerId;
  readonly promotionCodeId: string;
}): DiscountCandidate => {
  const promotionCodeId = promotionCodeIdSchema.make(referral.promotionCodeId);
  return {
    discount: {
      id: getReferralBenefitIds(referral.invitedDotyposCustomerId).invitation,
      label: m.checkoutSummaryItemReferralInvitationDiscount({}, { locale }),
      adjustment: {
        kind: "percentage",
        basisPoints: referralInvitationDiscountBasisPoints,
      },
    },
    provenance: {
      providerNamespace: "referral-invitation",
      providerReference: referral.promotionCodeId,
      details: {
        referralInvitation: {
          invitedDotyposCustomerId: referral.invitedDotyposCustomerId,
          referrerDotyposCustomerId: referral.referrerDotyposCustomerId,
          promotionCodeId,
        },
      },
    },
    claim: {
      kind: "referral_invitation",
      invitedDotyposCustomerId: referral.invitedDotyposCustomerId,
      referrerDotyposCustomerId: referral.referrerDotyposCustomerId,
      promotionCodeId,
    },
  };
};

/**
 * Starts a Nexi payment for a held reservation through the real lifecycle
 * admission. With `referral`, the attempt carries a checkout referral: it
 * reserves the invitation claim and records the attribution when paid.
 */
export const admitPendingNexiPayment = (
  repository: IPaymentLifecycleRepository,
  reservation: WorkspaceReservationRow,
  referral?: {
    readonly referrerDotyposCustomerId: DotyposCustomerId;
    readonly promotionCodeId: string;
  }
) =>
  Effect.gen(function* () {
    const dotyposCustomerId = requireValue(
      reservation.dotyposCustomerId,
      "provider customer ID"
    );
    const baseQuote = yield* buildCoworkReservationQuote(reservationDetails);
    const calculation = referral
      ? yield* calculateDiscounts({
          product,
          discountableSubtotal: baseQuote.payment.expectedPrice,
          candidates: [
            makeInvitationCandidate({
              invitedDotyposCustomerId: dotyposCustomerId,
              ...referral,
            }),
          ],
        })
      : undefined;
    const quote = yield* buildCoworkReservationQuote(
      reservationDetails,
      calculation ? { discountQuote: calculation.quote } : {}
    );
    const snapshot = makeAccountingDocumentSnapshot({
      workspaceReservationId: reservation.id,
      dotyposReservationId: requireValue(
        reservation.dotyposReservationId,
        "provider reservation ID"
      ),
      dotyposCustomerId,
      locale,
      prepared: {
        kind: "cowork",
        reservation: paymentLifecycleReservationOrder,
        quote,
      },
    });
    return yield* repository.createPendingProviderAttempt({
      provider: "nexi",
      orderId: standaloneReservationOrderId(reservation.id),
      providerOrderId: NexiOrderIdSchema.make(`order-${crypto.randomUUID()}`),
      amount: snapshot.quote.payment.expectedPrice,
      commitment: makeDiscountCommitment({
        product,
        firstServiceDate: "2099-01-01",
        applications: calculation?.applications ?? [],
      }),
      locale,
      accountingSnapshot: snapshot,
    });
  });

/**
 * A held reservation of a new invited customer whose unpaid Nexi attempt
 * reserved a referral invitation claim, admitted through the real lifecycle
 * repository on the test database.
 */
export const admitReferralNexiPayment = (
  database: Pick<WorkspacePostgresTestDatabase, "db" | "layer">
) =>
  Effect.gen(function* () {
    const invitedDotyposCustomerId = paymentLifecycleCustomerId();
    const referrerDotyposCustomerId = paymentLifecycleCustomerId();
    const [promotion] = yield* database.db
      .insert(promotionCodes)
      .values({
        kind: "referral",
        code: canonicalPromotionCodeSchema.make(
          `RFL${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`
        ),
        enabled: true,
      })
      .returning({ id: promotionCodes.id });
    const promotionCodeId = requireValue(
      promotion,
      "inserted promotion row"
    ).id;
    yield* database.db.insert(referralCodes).values({
      promotionCodeId,
      referrerDotyposCustomerId,
    });
    const reservation = yield* workspaceFixtures(database.db).reservation({
      stage: { reservation: "held" },
      customer: invitedDotyposCustomerId,
    });
    const attempt = yield* PaymentLifecycleRepository.use((repository) =>
      admitPendingNexiPayment(repository, reservation, {
        referrerDotyposCustomerId,
        promotionCodeId,
      })
    ).pipe(
      Effect.provide(
        PaymentLifecycleRepository.Default.pipe(
          Layer.provide(
            Layer.merge(
              database.layer,
              testAccountingStorage(
                database.layer,
                AccountingSnapshotKeyService.Default
              )
            )
          )
        )
      )
    );
    return { attempt, reservation };
  });
