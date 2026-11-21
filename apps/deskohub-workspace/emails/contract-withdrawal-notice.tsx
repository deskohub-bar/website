import { Link, Section, Text } from "react-email";
import { m } from "@/features/i18n";
import { formatReservationDisplayDateTime } from "@/features/reservation/reservation-date";
import type { WithdrawalRefundBasis } from "@/features/withdrawal/withdrawal-assessment";
import type { WithdrawableContractKind } from "@/features/withdrawal/withdrawal-identifiers";
import { staffLocale } from "@/shared/backend/staff-locale";
import { formatMoney, type Money } from "@/shared/money/money";
import { emailWithBreak } from "@/shared/utils/email-with-break";
import { WithdrawalRefundBreakdown } from "./_components/withdrawal-refund-breakdown";
import {
  WorkspaceEmailHeading,
  WorkspaceEmailLabel,
} from "./_components/workspace-email-content";
import { WorkspaceEmailDetails } from "./_components/workspace-email-details";
import { WorkspaceEmailLayout } from "./_components/workspace-email-layout";
import { contractWithdrawalNoticePreviewProps } from "./_fixtures/preview-props";
import type { WorkspaceEmailDetail } from "./workspace-email-detail";

export type ContractWithdrawalNoticeEmailProps = {
  readonly contractKind?: WithdrawableContractKind;
  readonly contractLabel: string;
  /** The family's contract id, such as the reservation id. */
  readonly contractId: string;
  readonly accountId: string;
  /** The customer's name, when their profile has one. */
  readonly customerName: string | null;
  readonly customerEmail: string;
  readonly submittedAt: Temporal.Instant;
  readonly paidAmount: Money;
  readonly refundAmount: Money;
  readonly refundBasis: WithdrawalRefundBasis;
  /** The reservation in administration, where its payment is refunded. */
  readonly adminUrl?: string;
  /**
   * When the reservation was cancelled, if it already was when this notice
   * went out; cancelling runs after the emails, so usually not yet.
   */
  readonly cancelledAt: Temporal.Instant | null;
};

/** The subject before the staff marker. */
export const contractWithdrawalNoticeEmailSubject = ({
  contractKind,
  contractLabel,
  refundAmount,
}: Pick<
  ContractWithdrawalNoticeEmailProps,
  "contractKind" | "contractLabel" | "refundAmount"
>) => {
  const messageOptions = { locale: staffLocale };
  if (contractKind === "unlimited-pass") {
    return `${m.withdrawalNoticeEmailHeading({}, messageOptions)} · ${contractLabel}`;
  }
  return refundAmount.value > 0
    ? m.withdrawalNoticeEmailSubject(
        {
          amount: formatMoney(refundAmount, staffLocale),
          contract: contractLabel,
        },
        messageOptions
      )
    : m.withdrawalNoticeEmailSubjectNoRefund(
        { contract: contractLabel },
        messageOptions
      );
};

const pragueTime = (instant: Temporal.Instant) =>
  m.withdrawalEmailPragueTime(
    { time: formatReservationDisplayDateTime(instant, staffLocale) },
    { locale: staffLocale }
  );

/**
 * Tells staff a customer withdrew online and carries the submitted details.
 */
export function ContractWithdrawalNoticeEmail(
  props: ContractWithdrawalNoticeEmailProps
) {
  const messageOptions = { locale: staffLocale };
  const refunds = props.refundAmount.value > 0;
  const reservation = props.contractKind !== "unlimited-pass";
  const formattedRefund = formatMoney(props.refundAmount, staffLocale);
  const reservationRefundInstruction = refunds
    ? m.withdrawalNoticeActionRefund(
        { amount: formattedRefund },
        messageOptions
      )
    : m.withdrawalNoticeActionNoRefund({}, messageOptions);
  const details: readonly WorkspaceEmailDetail[] = [
    {
      label: m.withdrawalNoticeCustomerLabel({}, messageOptions),
      value:
        props.customerName ?? m.withdrawalNoticeNameMissing({}, messageOptions),
    },
    {
      label: m.withdrawalEmailEmailLabel({}, messageOptions),
      value: emailWithBreak(props.customerEmail),
    },
    {
      label: reservation
        ? m.withdrawalReservationReference({}, messageOptions)
        : m.checkoutStatusOrderIdLabel({}, messageOptions),
      value: props.contractId,
    },
    {
      label: reservation
        ? m.withdrawalReservationLabel({}, messageOptions)
        : m.withdrawalEmailContractLabel({}, messageOptions),
      value: props.contractLabel,
    },
    {
      label: m.withdrawalSubmittedAt({}, messageOptions),
      value: pragueTime(props.submittedAt),
    },
    ...(props.refundBasis.kind === "full"
      ? [
          {
            label: m.withdrawalPaidAmount({}, messageOptions),
            value: formatMoney(props.paidAmount, staffLocale),
          },
          {
            label: m.withdrawalNoticeRefundLabel({}, messageOptions),
            value: formattedRefund,
          },
        ]
      : []),
    ...(reservation
      ? [
          {
            label: m.withdrawalNoticeCancellationLabel({}, messageOptions),
            value: props.cancelledAt
              ? m.withdrawalNoticeCancelledAt(
                  { time: pragueTime(props.cancelledAt) },
                  messageOptions
                )
              : m.withdrawalNoticeCancellationPending({}, messageOptions),
          },
        ]
      : []),
  ];

  return (
    <WorkspaceEmailLayout
      locale={staffLocale}
      preview={contractWithdrawalNoticeEmailSubject(props)}
    >
      <WorkspaceEmailHeading>
        {m.withdrawalNoticeEmailHeading({}, messageOptions)}
      </WorkspaceEmailHeading>
      <Section className="mt-5 rounded-2xl bg-cream px-5 py-5">
        <WorkspaceEmailLabel>
          {m.withdrawalNoticeActionLabel({}, messageOptions)}
        </WorkspaceEmailLabel>
        <Text className="m-0 mt-2 text-[22px] font-bold leading-[28px] text-navy">
          {reservation
            ? reservationRefundInstruction
            : m.withdrawalNoticeCheckPassRefund({}, messageOptions)}
        </Text>
        {refunds && reservation && (
          <Text className="m-0 mt-2 text-[14px] leading-[22px] text-[#565975]">
            {m.withdrawalNoticeActionHint({}, messageOptions)}
          </Text>
        )}
        {props.adminUrl && (
          <Link
            className="mt-4 inline-block rounded-full bg-navy px-6 py-3 text-[14px] font-bold leading-[20px] text-white no-underline"
            href={props.adminUrl}
            style={{ backgroundColor: "#00024f", color: "#ffffff" }}
          >
            {m.withdrawalNoticeOpenAdmin({}, messageOptions)}
          </Link>
        )}
      </Section>
      <WorkspaceEmailDetails details={details} wrapWords />
      <WithdrawalRefundBreakdown
        locale={staffLocale}
        paidAmount={props.paidAmount}
        refundAmount={props.refundAmount}
        refundBasis={props.refundBasis}
        refundLabel={m.withdrawalNoticeRefundLabel({}, messageOptions)}
      />
    </WorkspaceEmailLayout>
  );
}

ContractWithdrawalNoticeEmail.PreviewProps =
  contractWithdrawalNoticePreviewProps;

export default ContractWithdrawalNoticeEmail;
