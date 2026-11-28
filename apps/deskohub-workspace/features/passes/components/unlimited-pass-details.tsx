import { getAccountSignInPath } from "@/features/account/routes";
import { getWorkspaceProductMonitorTitle } from "@/features/checkout/product-catalog.i18n";
import { m } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { formatMoney, moneyWithValue } from "@/shared/money/money";
import { formatCount } from "@/shared/utils/number";
import {
  getUnlimitedPassPrice,
  unlimitedPassCoffeePrice,
  unlimitedPassDays,
} from "../pass-offer";
import { formatPassDate, getPassTierName } from "../pass-offer.i18n";
import type { UnlimitedPassSelection } from "../unlimited-pass";
import {
  getUnlimitedPassDetailsPath,
  type UnlimitedPassOrderLink,
} from "../unlimited-pass-checkout";
import {
  PassPurchaseDetails,
  type PassPurchaseDetailsProps,
  PassPurchaseSummaryItem,
} from "./pass-purchase-details";

export function UnlimitedPassDetails({
  selection,
  order,
  renewsPassId,
  ...props
}: PassPurchaseDetailsProps & {
  readonly selection: UnlimitedPassSelection;
  readonly order?: UnlimitedPassOrderLink;
  readonly renewsPassId?: OrderId;
}) {
  const { locale } = props;
  const passPrice = getUnlimitedPassPrice({
    kind: "unlimited",
    tier: selection.tier,
  });
  const hasCoffeeAddOn = selection.tier === "open-space" && selection.coffee;
  const total = formatMoney(
    hasCoffeeAddOn
      ? moneyWithValue(
          passPrice.value + unlimitedPassCoffeePrice.value,
          passPrice
        )
      : passPrice,
    locale
  );
  return (
    <PassPurchaseDetails
      {...props}
      product={{ kind: "unlimited" }}
      allowGift={!renewsPassId}
      signInPath={getAccountSignInPath(
        locale,
        getUnlimitedPassDetailsPath(locale, selection, order, renewsPassId)
      )}
      summary={
        <>
          <PassPurchaseSummaryItem
            label={m.entryPackCheckoutWorkspace({}, { locale })}
            value={
              <>
                {getPassTierName(selection.tier, locale)}
                {selection.tier !== "open-space" && (
                  <span className="mt-1 block text-navy-blue/75 text-sm">
                    {m.reservationReservedDeskPerkCoffee({}, { locale })}
                  </span>
                )}
              </>
            }
          />
          <PassPurchaseSummaryItem
            label={m.unlimitedPassCheckoutStartDate({}, { locale })}
            value={formatPassDate(selection.startDate, locale)}
          />
          <PassPurchaseSummaryItem
            label={m.entryPackCheckoutPrice({}, { locale })}
            value={
              hasCoffeeAddOn ? (
                <dl className="mt-1 space-y-1 wrap-anywhere text-sm">
                  <div className="flex justify-between gap-x-2">
                    <dt>{m.passUnlimited({}, { locale })}</dt>
                    <dd className="whitespace-nowrap">
                      {formatMoney(passPrice, locale)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-x-2">
                    <dt>
                      {m.unlimitedPassCheckoutCoffee(
                        { days: formatCount(unlimitedPassDays, locale) },
                        { locale }
                      )}
                    </dt>
                    <dd className="whitespace-nowrap">
                      +{formatMoney(unlimitedPassCoffeePrice, locale)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-x-2 border-navy-blue/10 border-t pt-1 font-semibold">
                    <dt>{m.checkoutSummarySectionTotal({}, { locale })}</dt>
                    <dd className="whitespace-nowrap">{total}</dd>
                  </div>
                </dl>
              ) : (
                total
              )
            }
          />
          {selection.tier === "reserved-desk-workstation" && (
            <PassPurchaseSummaryItem
              label={m.reservationMonitorLabel({}, { locale })}
              value={getWorkspaceProductMonitorTitle(
                selection.monitorOption,
                locale
              )}
            />
          )}
        </>
      }
    />
  );
}
