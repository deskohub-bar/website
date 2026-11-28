import { getAccountSignInPath } from "@/features/account/routes";
import { m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { formatMoney } from "@/shared/money/money";
import { getEntryPackDetailsPath } from "../entry-pack-checkout";
import { type EntryPackProduct, getEntryPackPrice } from "../pass-offer";
import { formatPassDate, getPassTierName } from "../pass-offer.i18n";
import {
  PassPurchaseDetails,
  type PassPurchaseDetailsProps,
  PassPurchaseSummaryItem,
} from "./pass-purchase-details";

export function EntryPackDetails({
  product,
  validUntil,
  orderId,
  ...props
}: PassPurchaseDetailsProps & {
  readonly product: EntryPackProduct;
  readonly validUntil?: string;
  readonly orderId?: OrderId;
}) {
  const { locale } = props;
  return (
    <PassPurchaseDetails
      {...props}
      product={product}
      signInPath={getAccountSignInPath(
        locale,
        getEntryPackDetailsPath(locale, product, orderId)
      )}
      summary={
        <>
          <PassPurchaseSummaryItem
            label={m.entryPackCheckoutWorkspace({}, { locale })}
            value={getPassTierName(product.tier, locale)}
          />
          {validUntil && (
            <PassPurchaseSummaryItem
              label={m.entryPackCheckoutValidUntil({}, { locale })}
              value={formatPassDate(validUntil, locale)}
            />
          )}
          <PassPurchaseSummaryItem
            label={m.entryPackCheckoutPrice({}, { locale })}
            value={formatMoney(getEntryPackPrice(product), locale)}
          />
        </>
      }
    />
  );
}
