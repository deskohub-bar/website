import type { CustomerAccountId } from "@/features/account/customer-account";
import type { PassStatus } from "../pass";

/**
 * Matches the site-viewer access rule in `entry-pack-status.ts`: a held pass
 * links to `/reservation/status/{orderId}` only when that route will answer
 * for the signed-in holder (the buyer, or a claimed holder of a fulfilled
 * complimentary grant). Paid gifts owned by another buyer return not-found.
 */
export function canHolderViewPassOrderStatus(
  pass: {
    readonly buyerAccountId: CustomerAccountId;
    readonly paymentState: string;
    readonly fulfillmentState: string;
    readonly status: PassStatus;
    readonly giftClaimedAt: Temporal.Instant | null;
  },
  holderAccountId: CustomerAccountId
): boolean {
  if (pass.paymentState === "complimentary") {
    return (
      pass.fulfillmentState === "fulfilled" &&
      pass.status !== "pending_payment" &&
      pass.status !== "void" &&
      (pass.buyerAccountId === holderAccountId || pass.giftClaimedAt !== null)
    );
  }
  return pass.buyerAccountId === holderAccountId;
}
