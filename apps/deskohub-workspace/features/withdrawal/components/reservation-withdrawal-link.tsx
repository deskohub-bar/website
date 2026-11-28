import type { Locale } from "@/features/i18n";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { WithdrawalLink } from "./withdrawal-link";

/**
 * The prominent "Withdraw from the contract" link (§1830a(2)) of a
 * reservation the customer can withdraw from now. It opens the withdrawal
 * dialog over the current page: the live quote, the statement to confirm,
 * then the receipt. Closing the dialog after a withdrawal refreshes the page,
 * so it shows the reservation cancelled.
 */
export function ReservationWithdrawalLink({
  className,
  locale,
  orderId,
  reference,
}: {
  /** Placement classes of this surface. */
  readonly className?: string;
  readonly locale: Locale;
  readonly orderId: WorkspaceReservationId;
  /** The reservation number as the surface shows it. */
  readonly reference: string;
}) {
  return (
    <WithdrawalLink
      className={className}
      contract={{ kind: "reservation", orderId }}
      locale={locale}
      reference={reference}
    />
  );
}
