import "server-only";

import { Effect } from "effect";
import { FioAccounts } from "../fio/fio-accounts.service";
import { configuredPaymentProvider } from "../payment/payment-provider-selection";

export const getPublicReservationPaymentAccount = (accountKey?: string) =>
  FioAccounts.pipe(
    Effect.map((accounts) => {
      if (configuredPaymentProvider() === "mock") return undefined;
      return accountKey === undefined
        ? accounts.getDefaultReceivingAccount()
        : accounts.getReceivingAccountDisplay(accountKey);
    })
  );
