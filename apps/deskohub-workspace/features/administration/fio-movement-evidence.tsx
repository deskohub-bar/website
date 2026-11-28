import { formatCurrencyAmount } from "@deskohub/i18n/currency";
import type { FioStaffSettlement } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";
import type { Locale } from "@/features/i18n";
import { moneyToDecimalString } from "@/shared/money/money";
import { AdministrationLink } from "./admin-link";
import { administrationHref } from "./administration-href";
import {
  AdministrationDetailSection,
  AdministrationFact,
} from "./detail-components";
import { FioRefundForm } from "./fio-refund-form";
import {
  formatAdministrationDateTime,
  formatAdministrationPlainDate,
} from "./formatters";
import { m } from "./i18n";

const dispositionLabels = {
  discrepancy: m.administrationFioDiscrepancy,
  winner: m.administrationFioAccepted,
  recovery_pending: m.administrationFioRecoveryPending,
  review_required: m.administrationFioReviewRequired,
  refund_required: m.administrationFioRefundRequired,
  refunded: m.administrationFioRefundRecorded,
};
const discrepancyLabels = {
  reference_absent: m.administrationFioReferenceAbsent,
  reference_invalid: m.administrationFioReferenceInvalid,
  reference_unmatched: m.administrationFioReferenceUnmatched,
  non_credit: m.administrationFioNonCredit,
  amount_mismatch: m.administrationFioAmountMismatch,
  currency_mismatch: m.administrationFioCurrencyMismatch,
};

type EvidenceSource = "order" | "reservation" | "queue";

const formatFioCzkAmount = (value: number, locale: Locale) =>
  formatCurrencyAmount({
    amount: moneyToDecimalString({ value, currency: "CZK", exponent: 2 }),
    currency: "CZK",
    fractionDigits: 2,
    locale,
  });

export function FioMovementEvidence({
  locale,
  movements,
  source,
}: {
  readonly locale: Locale;
  readonly movements: readonly FioStaffSettlement[];
  readonly source: EvidenceSource;
}) {
  if (!movements.length) return null;

  return (
    <AdministrationDetailSection
      title={m.administrationFioMovements({}, { locale })}
    >
      <ul className="divide-y divide-navy-blue/10">
        {movements.map((movement) => {
          const amount =
            movement.amountValue === null
              ? `${movement.decimalAmount} ${movement.currency}`
              : formatFioCzkAmount(movement.amountValue, locale);
          return (
            <li className="py-4 first:pt-0 last:pb-0" key={movement.id}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                <AdministrationFact
                  label={m.administrationFioMovementId({}, { locale })}
                  value={movement.movementId}
                  valueClassName="break-all font-mono"
                />
                <AdministrationFact
                  label={m.administrationFioProvider({}, { locale })}
                  value="Fio"
                />
                <AdministrationFact
                  label={m.administrationOrderFactAmount({}, { locale })}
                  value={amount}
                />
                {movement.disposition === "refund_required" && (
                  <AdministrationFact
                    label={m.administrationFioRefundAmount({}, { locale })}
                    value={
                      movement.refundTargetValue === null
                        ? amount
                        : formatFioCzkAmount(movement.refundTargetValue, locale)
                    }
                  />
                )}
                {movement.variableSymbol && (
                  <AdministrationFact
                    label={m.administrationFioVariableSymbol({}, { locale })}
                    value={movement.variableSymbol}
                    valueClassName="break-all font-mono"
                  />
                )}
                <AdministrationFact
                  label={m.administrationFioBookingDate({}, { locale })}
                  value={
                    <time dateTime={movement.bookingDate}>
                      {formatAdministrationPlainDate(
                        movement.bookingDate,
                        locale
                      )}
                    </time>
                  }
                />
                <AdministrationFact
                  label={m.administrationFioObservedAt({}, { locale })}
                  value={
                    <time dateTime={movement.observedAt.toString()}>
                      {formatAdministrationDateTime(
                        movement.observedAt.toString(),
                        locale
                      )}
                    </time>
                  }
                />
                <AdministrationFact
                  label={m.administrationFioOutcome({}, { locale })}
                  value={dispositionLabels[movement.disposition](
                    {},
                    { locale }
                  )}
                />
                {movement.discrepancyReason && (
                  <AdministrationFact
                    label={m.administrationFioReason({}, { locale })}
                    value={discrepancyLabels[movement.discrepancyReason](
                      {},
                      { locale }
                    )}
                  />
                )}
                {movement.refundedAt && (
                  <AdministrationFact
                    label={m.administrationFioRefundedAt({}, { locale })}
                    value={
                      <time dateTime={movement.refundedAt.toString()}>
                        {formatAdministrationDateTime(
                          movement.refundedAt.toString(),
                          locale
                        )}
                      </time>
                    }
                  />
                )}
              </dl>
              {movement.orderId && source !== "order" && (
                <AdministrationLink
                  className="mt-3 inline-block text-sm font-semibold underline underline-offset-4"
                  href={administrationHref("/[locale]/admin/orders/[orderId]", {
                    orderId: movement.orderId,
                  })}
                >
                  {m.administrationFioViewOrder({}, { locale })}
                </AdministrationLink>
              )}
              {source !== "queue" &&
                movement.disposition === "refund_required" && (
                  <FioRefundForm locale={locale} settlementId={movement.id} />
                )}
            </li>
          );
        })}
      </ul>
    </AdministrationDetailSection>
  );
}
