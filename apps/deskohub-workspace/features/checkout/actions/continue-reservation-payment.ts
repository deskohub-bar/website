"use server";

import { Effect, Layer } from "effect";
import { CheckoutService } from "@/features/checkout/backend/checkout/checkout.service";
import { checkoutSubmitDeadline } from "@/features/checkout/backend/checkout/checkout-submit-deadline";
import { publicReservationPaymentStatusServices } from "@/features/checkout/backend/checkout/public-reservation-payment-status.server";
import { m } from "@/features/i18n";
import { ReferralReleaseGateRequest } from "@/features/referrals/referral-release-gate.server";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";
import {
  continueReservationPaymentForAuthor,
  continueReservationPaymentSchema,
} from "./continue-reservation-payment.server";

const continueReservationPaymentServices = Layer.merge(
  CheckoutService.Live,
  publicReservationPaymentStatusServices
).pipe(Layer.provide(ReferralReleaseGateRequest));

const continueReservationPaymentAction = defineWorkspaceAction(
  {
    operation: "checkout.continue-reservation-payment",
    deadline: checkoutSubmitDeadline,
    fallback: m.checkoutPaySubmitError,
    schema: continueReservationPaymentSchema,
  },
  (input) =>
    continueReservationPaymentForAuthor(input).pipe(
      Effect.provide(continueReservationPaymentServices)
    )
);

export const continueReservationPayment: typeof continueReservationPaymentAction =
  async (...args) => {
    "use server";
    return await continueReservationPaymentAction(...args);
  };
