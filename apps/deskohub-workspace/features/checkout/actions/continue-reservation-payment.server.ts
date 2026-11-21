import "server-only";

import { Effect, Schema } from "effect";
import { CheckoutService } from "@/features/checkout/backend/checkout/checkout.service";
import { readAuthorPaymentWindow } from "@/features/checkout/backend/checkout/public-reservation-payment-status.server";
import { locales } from "@/features/i18n";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";

const continuePaymentInput = Schema.Struct({
  locale: Schema.Literals(locales),
  method: Schema.Literals(["card", "qr"]),
  orderId: workspaceReservationIdSchema,
});

export const continueReservationPaymentSchema =
  Schema.toStandardSchemaV1(continuePaymentInput);

export const continueReservationPaymentForAuthor = Effect.fn(
  "checkout.continueReservationPaymentForAuthor"
)(function* ({ locale, method, orderId }: typeof continuePaymentInput.Type) {
  const payment = yield* readAuthorPaymentWindow(orderId);
  if (!payment) return { status: "unavailable" } as const;

  const checkout = yield* CheckoutService;
  const result = yield* checkout.resumeReservationPayment(
    {
      reservationId: orderId,
      method,
      fio: { accountKey: payment.window.accountKey },
    },
    locale
  );

  if (result.status === "redirect")
    return { status: result.status, redirectUrl: result.redirectUrl };
  if (result.status === "qr_pending") return { status: result.status };
  return { status: "unavailable" } as const;
});
