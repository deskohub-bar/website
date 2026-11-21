import "server-only";

import { generateQrCodePngBuffer } from "@deskohub/qr-code";
import { Effect, Layer, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { CustomerAccountReservationOwnership } from "@/features/account/backend/customer-account-reservation-ownership";
import type { CheckoutQrPayment } from "@/features/checkout/components/checkout-qr-payment-details";
import { createReservationPaymentQrPayload } from "@/features/checkout/reservation-payment-qr";
import type { Locale } from "@/features/i18n";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import {
  reservationOrderId,
  type WorkspaceReservationId,
} from "@/features/reservation/persistence-contracts";
import { formatMoney } from "@/shared/money/money";
import { formatInstantDateTime } from "@/shared/utils/date-time-format";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { currentPreciseInstant } from "@/shared/utils/temporal";
import { FioAccounts } from "../fio/fio-accounts.service";
import { QrPaymentRepository } from "../repositories/qr-payment.repository";
import { PublicReservationAuthor } from "./public-pay-state-author.server";
import { getPublicReservationPaymentAccount } from "./public-reservation-payment-account";

export const publicReservationPaymentStatusServices = Layer.mergeAll(
  PublicReservationAuthor,
  WorkspaceReservationRepository.Live,
  QrPaymentRepository.Default.pipe(Layer.provide(WorkspaceDatabase.Default)),
  FioAccounts.Default
);

/** Only the active author can pay using the commitment already recorded. */
export const readAuthorPaymentWindow = Effect.fn(
  "checkout.readAuthorPaymentWindow"
)(function* (orderId: WorkspaceReservationId) {
  if (!(yield* getPublicReservationPaymentAccount())) return undefined;
  const ownership = yield* CustomerAccountReservationOwnership;
  const author = yield* ownership.activeAccountId.pipe(Effect.option);
  if (Option.isNone(author)) return undefined;

  const reservations = yield* WorkspaceReservationRepository;
  const reservation = yield* reservations.findById(orderId);
  if (
    !reservation ||
    reservation.authorAccountId !== author.value ||
    reservation.agentClientId ||
    reservation.reservationState !== "held" ||
    reservation.paymentState !== "pending" ||
    !reservation.activePaymentAttemptId
  )
    return undefined;

  const payments = yield* QrPaymentRepository;
  const window = yield* payments.findPaymentWindow(reservationOrderId(orderId));
  const now = yield* currentPreciseInstant;
  if (!window || Temporal.Instant.compare(window.expiresAt, now) <= 0)
    return undefined;
  const account = yield* getPublicReservationPaymentAccount(window.accountKey);
  return account ? { window, account } : undefined;
});

/** This read can only follow the status route's existing access check. */
export const readAuthorPaymentStatus = Effect.fn(
  "checkout.readAuthorPaymentStatus"
)(function* (orderId: WorkspaceReservationId, locale: Locale) {
  const payment = yield* readAuthorPaymentWindow(orderId);
  if (!payment) return undefined;
  const { account, window } = payment;
  const expiresAt = window.expiresAt.toString();
  if (!window.qrAttemptId) return { expiresAt };

  const payments = yield* QrPaymentRepository;
  const qr = yield* payments.findForReservation(orderId);
  if (
    !qr ||
    qr.accountKey !== account.accountKey ||
    !/^\d{1,10}$/.test(qr.variableSymbol)
  )
    return undefined;

  const payload = createReservationPaymentQrPayload({
    account,
    amount: qr.amount,
    variableSymbol: qr.variableSymbol,
  });
  const png = yield* Effect.promise(() =>
    generateQrCodePngBuffer(payload, {
      darkColor: "#000000ff",
      lightColor: "#ffffffff",
      margin: 4,
      width: 352,
    })
  );
  if (
    Temporal.Instant.compare(window.expiresAt, yield* currentPreciseInstant) <=
    0
  )
    return undefined;
  const accountNumber = account.accountPrefix
    ? `${account.accountPrefix}-${account.accountNumber}/${account.bankCode}`
    : `${account.accountNumber}/${account.bankCode}`;

  return {
    expiresAt,
    qrPayment: {
      accountNumber,
      amount: formatMoney(qr.amount, locale),
      deadline: formatInstantDateTime({
        instant: window.expiresAt,
        locale,
        timeZone: workspaceSiteConstants.location.timeZone,
      }),
      expiresAt,
      qrCodeSource: `data:image/png;base64,${png.toString("base64")}`,
      variableSymbol: qr.variableSymbol,
    } satisfies CheckoutQrPayment,
  };
});
