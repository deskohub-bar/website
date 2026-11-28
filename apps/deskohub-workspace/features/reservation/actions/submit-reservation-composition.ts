import { Effect, Layer } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CheckoutService } from "@/features/checkout/backend/checkout";
import { publicPayStateAuthorServices } from "@/features/checkout/backend/checkout/public-pay-state-author.server";
import { FioAccounts } from "@/features/checkout/backend/fio/fio-accounts.service";
import { ReferralService } from "@/features/referrals";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import type { SubmitReservationInput } from "@/features/reservation/actions/submit-reservation-input";
import { submitWorkspaceReservation } from "./submit-workspace-reservation";

const liveLayers = RememberedReferral.Cookies.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CheckoutService.Live,
      CurrentCustomerAccount.Live,
      FioAccounts.Default,
      publicPayStateAuthorServices,
      ReferralService.Live
    )
  )
);

export const submitReservationEffect = (
  input: SubmitReservationInput,
  layers = liveLayers
) => submitWorkspaceReservation(input).pipe(Effect.provide(layers));
