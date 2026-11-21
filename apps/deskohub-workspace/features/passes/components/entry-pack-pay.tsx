import { getAccountSignInPath } from "@/features/account/routes";
import { m } from "@/features/i18n";
import { getEntryPackDetailsPath } from "../entry-pack-checkout";
import {
  payEntryPackCheckout,
  repriceEntryPackCheckout,
} from "../entry-pack-checkout-actions";
import { getPassTierName } from "../pass-offer.i18n";
import type { EntryPackPayState } from "./entry-pack-checkout";
import {
  PassPurchasePay,
  type PassPurchasePayProps,
} from "./pass-purchase-pay";

export function EntryPackPay({
  state,
  continuationPath,
  ...props
}: PassPurchasePayProps & {
  readonly state: EntryPackPayState;
  readonly continuationPath?: string | undefined;
}) {
  const { locale, orderId } = props;
  const { product } = state;
  return (
    <PassPurchasePay
      {...props}
      state={state}
      product="entry-pack"
      signInPath={getAccountSignInPath(
        locale,
        continuationPath ?? getEntryPackDetailsPath(locale, product, orderId)
      )}
      orderLabel={m.entryPackCheckoutOrderLabel(
        { tier: getPassTierName(product.tier, locale), count: product.size },
        { locale }
      )}
      repriceCheckout={repriceEntryPackCheckout}
      payCheckout={payEntryPackCheckout}
    />
  );
}
