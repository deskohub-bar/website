"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  quoteContractWithdrawal,
  type WithdrawalQuoteResult,
  type WithdrawalResult,
  withdrawFromContract,
} from "@/features/account/withdrawal-actions";
import { type Locale, m } from "@/features/i18n";
import type { WithdrawalQuoteData } from "@/features/withdrawal/withdrawal-read-model";
import { cn } from "@/shared/utils";
import { useWorkspaceAction } from "@/shared/utils/use-workspace-action";
import {
  WithdrawalConfirmDialog,
  type WithdrawalDialogView,
} from "./withdrawal-confirm-dialog";

type StatementQuote = {
  readonly quote: WithdrawalQuoteData;
  readonly refundChanged: boolean;
};

/** Opens the live quote, the statement to confirm, and its receipt. */
export function WithdrawalLink({
  className,
  contract,
  locale,
  reference,
}: {
  readonly className?: string;
  readonly contract: Parameters<typeof quoteContractWithdrawal>[0]["contract"];
  readonly locale: Locale;
  readonly reference: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [statementQuote, setStatementQuote] = useState<StatementQuote>();
  const quote = useWorkspaceAction(quoteContractWithdrawal, {});
  const withdrawal = useWorkspaceAction(withdrawFromContract, {
    onSuccess: ({ data }) => {
      if (data.status === "refund_changed") {
        setStatementQuote({ quote: data.quote, refundChanged: true });
      }
    },
  });

  const loadQuote = () => quote.execute({ contract });

  const openDialog = () => {
    withdrawal.reset();
    setStatementQuote(undefined);
    setOpen(true);
    loadQuote();
  };

  const changeOpen = (next: boolean) => {
    if (next || withdrawal.isExecuting) return;
    setOpen(false);
    if (withdrawal.result.data?.status === "withdrawn") router.refresh();
  };

  const view = dialogView({
    quoted: quote.result.data,
    statementQuote:
      statementQuote?.quote.contractId === contract.orderId
        ? statementQuote
        : undefined,
    quoteServerError: quote.result.serverError,
    quoteSettled: !quote.isIdle && !quote.isExecuting,
    submitted: withdrawal.result.data,
    submitError: withdrawal.hasErrored
      ? (withdrawal.result.serverError ??
        m.withdrawalSubmitFailed({}, { locale }))
      : undefined,
    submitting: withdrawal.isExecuting,
  });

  const confirm = (customerName: string | undefined) => {
    if (view.step !== "statement" || view.pending) return;
    setStatementQuote({ quote: view.quote, refundChanged: view.refundChanged });
    withdrawal.execute({
      contract,
      refundTermsKey: view.quote.refundTermsKey,
      ...(customerName !== undefined && { customerName }),
    });
  };

  return (
    <>
      <button
        className={cn(
          "shrink-0 cursor-pointer self-center py-1 text-right text-[0.6875rem] leading-4 text-rose-700 underline-offset-4 hover:text-rose-800 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-burned-orange focus-visible:ring-offset-2",
          className
        )}
        data-pass-withdrawal-link={
          contract.kind === "reservation" ? undefined : ""
        }
        data-reservation-withdrawal-link={
          contract.kind === "reservation" ? "" : undefined
        }
        onClick={openDialog}
        type="button"
      >
        {m.reservationWithdrawalAction({}, { locale })}
      </button>
      <WithdrawalConfirmDialog
        contractKind={contract.kind}
        locale={locale}
        onConfirm={confirm}
        onOpenChange={changeOpen}
        onRetry={loadQuote}
        open={open}
        reference={reference}
        view={view}
      />
    </>
  );
}

/** What the dialog shows for the quote and the submission so far. */
function dialogView({
  quoted,
  statementQuote,
  quoteServerError,
  quoteSettled,
  submitError,
  submitted,
  submitting,
}: {
  readonly quoted: WithdrawalQuoteResult | undefined;
  readonly statementQuote: StatementQuote | undefined;
  readonly quoteServerError: string | undefined;
  readonly quoteSettled: boolean;
  readonly submitError: string | undefined;
  readonly submitted: WithdrawalResult | undefined;
  readonly submitting: boolean;
}): WithdrawalDialogView {
  if (submitted?.status === "refused") {
    return { step: "refused", reason: submitted.reason };
  }
  const current =
    submitted?.status === "refund_changed"
      ? { quote: submitted.quote, refundChanged: true }
      : (statementQuote ??
        (quoteSettled && quoted?.status === "available"
          ? { quote: quoted.quote, refundChanged: false }
          : undefined));
  if (!current) {
    if (!quoteSettled) return { step: "loading" };
    if (quoted?.status === "refused") {
      return { step: "refused", reason: quoted.reason };
    }
    return { step: "failed", message: quoteServerError };
  }
  if (submitted?.status === "withdrawn") {
    return {
      step: "received",
      quote: current.quote,
      receipt: submitted.receipt,
    };
  }
  return {
    step: "statement",
    ...current,
    pending: submitting,
    submitError,
    nameRequired: submitted?.status === "name_required",
  };
}
