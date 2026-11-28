import { Effect } from "effect";
import {
  InvoiceCancellationNoticeEmail,
  type InvoiceCancellationNoticeEmailProps,
  invoiceCancellationNoticeEmailTitle,
} from "@/emails/invoice-cancellation-notice";
import type { CorrectiveDocument } from "@/features/accounting/corrective-document";
import { getInvoiceEmailReference } from "@/features/accounting/invoice";
import type { InvoiceEmailDeliveryAudience } from "@/features/accounting/invoice-email-delivery";
import { renderWorkspaceEmail } from "@/shared/backend/email/render-react-email";
import { internalWorkspaceEmailSubject } from "@/shared/backend/email/workspace-email-recipients";
import type { Invoice } from "./invoice.repository";

/**
 * Renders the notice that a cancelled invoice's corrective document carries
 * to one audience: the customer in the document's locale, staff in the staff
 * locale.
 */
export const renderInvoiceCancellationNoticeEmail = (input: {
  readonly invoice: Invoice;
  readonly correctiveDocument: CorrectiveDocument;
  readonly audience: InvoiceEmailDeliveryAudience;
}) => {
  const { correctiveDocument } = input;
  const props: InvoiceCancellationNoticeEmailProps = {
    invoiceNumber: correctiveDocument.correctedInvoice.invoiceNumber,
    documentNumber: correctiveDocument.documentNumber,
    invoice: getInvoiceEmailReference(input.invoice.document),
    settlement: {
      currency: correctiveDocument.currency,
      settlement: correctiveDocument.settlement,
      total: correctiveDocument.total,
    },
    recipient:
      input.audience === "customer"
        ? { audience: "customer", locale: correctiveDocument.locale }
        : { audience: "internal" },
  };
  const title = invoiceCancellationNoticeEmailTitle(props);

  return Effect.map(
    renderWorkspaceEmail(<InvoiceCancellationNoticeEmail {...props} />),
    (rendered) => ({
      subject:
        input.audience === "customer"
          ? title
          : internalWorkspaceEmailSubject(title),
      ...rendered,
    })
  );
};
