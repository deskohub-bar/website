import { Context, Effect, Layer } from "effect";
import {
  beginPurchase,
  payPurchase,
  purchaseStartDates,
  purchaseStatus,
  repricePurchase,
  startPurchase,
} from "./customer-pass-purchase";
import {
  getCustomerPassBookingOptions,
  getCustomerReservationPassFunding,
  getCustomerUnlimitedAccess,
  getCustomerUnlimitedAccessPath,
  listCustomerPasses,
  listCustomerPassOffers,
  requireCustomerPassAccount,
} from "./customer-pass-reads";
import { requestEntryPackGiftResend } from "./entry-pack-gift-resend";

const requireActivePassAccount =
  <Input, Value, E, R>(
    operation: (input: Input) => Effect.Effect<Value, E, R>
  ) =>
  (input: Input) =>
    requireCustomerPassAccount().pipe(Effect.andThen(() => operation(input)));

const purchases = {
  beginPurchase: requireActivePassAccount(beginPurchase),
  startPurchase: requireActivePassAccount(startPurchase),
  purchaseStartDates: requireActivePassAccount(purchaseStartDates),
  payPurchase: requireActivePassAccount(payPurchase),
  purchaseStatus: requireActivePassAccount(purchaseStatus),
  repricePurchase: requireActivePassAccount(repricePurchase),
  resendInvitation: requireActivePassAccount(requestEntryPackGiftResend),
};

type CustomerPassPurchases = typeof purchases;

interface ICustomerPasses extends CustomerPassPurchases {
  readonly catalog: typeof listCustomerPassOffers;
  readonly list: typeof listCustomerPasses;
  readonly options: typeof getCustomerPassBookingOptions;
  readonly todayCode: typeof getCustomerUnlimitedAccess;
  readonly accessPath: typeof getCustomerUnlimitedAccessPath;
  readonly reservationFunding: typeof getCustomerReservationPassFunding;
}

export class CustomerPasses extends Context.Service<
  CustomerPasses,
  ICustomerPasses
>()("@deskohub-workspace/passes/CustomerPasses") {
  static Default = Layer.succeed(this, {
    ...purchases,
    catalog: listCustomerPassOffers,
    list: listCustomerPasses,
    options: getCustomerPassBookingOptions,
    todayCode: getCustomerUnlimitedAccess,
    accessPath: getCustomerUnlimitedAccessPath,
    reservationFunding: getCustomerReservationPassFunding,
  });
}
