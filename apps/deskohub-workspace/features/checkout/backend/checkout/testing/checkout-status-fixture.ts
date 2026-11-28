import { Effect } from "effect";
import type { IReservationAuthorizationService } from "@/features/reservation/backend/reservation-authorization.service";
import { WorkspaceReservationDetailsMalformedError } from "@/features/reservation/backend/stored-reservation-details.server";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import type { CheckoutStatusViewModel } from "../checkout-status.service";

export const fulfilledCheckoutStatus = {
  orderId: workspaceReservationIdSchema.make(
    "0198c1a2-4e99-7263-8b3c-c431ca140117"
  ),
  returnOutcome: "success",
  kind: "cowork",
  status: "fulfilled",
  paymentStatus: "paid",
  fulfillmentStatus: "fulfilled",
} satisfies CheckoutStatusViewModel;

export const failedCheckoutStatusRead = (message: string) =>
  Effect.fail(
    new WorkspaceReservationDetailsMalformedError({
      reservationId: fulfilledCheckoutStatus.orderId,
      message,
      cause: new Error(message),
    })
  );

export const statusPageAuthorizationFixture = (
  isAuthorized: IReservationAuthorizationService["isAuthorized"] = () =>
    Effect.succeed(true)
): IReservationAuthorizationService => ({
  isAuthorized,
  authorize: () => Effect.die("The status page must use isAuthorized"),
  authorizeViewer: () => Effect.die("The status page must use isAuthorized"),
});
