import {
  CustomerMonitorOption,
  type CustomerPassCatalog,
  type CustomerPassPurchaseProduct,
  CustomerPassTier,
  CustomerPlainDate,
  type CustomerUnlimitedStartDates,
  type Money,
} from "@deskohub/workspace-customer-api";
import { Schema } from "effect";
import { addDays } from "../../booking/selection/prague-date";

export type PurchaseKind = CustomerPassPurchaseProduct["kind"];

export interface PassPurchaseSelection {
  readonly tier: CustomerPassTier;
  readonly size: 5 | 10;
  readonly startDate?: string;
  readonly coffee: boolean;
  readonly monitorOption?: CustomerMonitorOption;
}

type PublicSelectionParams = Partial<
  Record<keyof PassPurchaseSelection, string | string[]>
>;

/** Only the public, editable booking selection crosses into the purchase URL. */
export const readPassPurchasePrefill = (
  kind: PurchaseKind,
  { tier, size, coffee, monitorOption, startDate }: PublicSelectionParams
): PassPurchaseSelection => {
  const monitor = Schema.is(CustomerMonitorOption)(monitorOption)
    ? monitorOption
    : undefined;
  const selectedTier = Schema.is(CustomerPassTier)(tier) ? tier : "open-space";
  const date =
    kind === "unlimited" &&
    Schema.is(CustomerPlainDate)(startDate) &&
    addDays(startDate, 0) === startDate
      ? startDate
      : undefined;
  return {
    tier:
      selectedTier === "reserved-desk" && monitor !== undefined
        ? "reserved-desk-workstation"
        : selectedTier,
    size: size === "10" ? 10 : 5,
    coffee:
      kind === "unlimited" && selectedTier === "open-space" && coffee === "1",
    ...(date === undefined ? {} : { startDate: date }),
    ...(monitor === undefined || selectedTier === "open-space"
      ? {}
      : { monitorOption: monitor }),
  };
};

export const availableStartDates = (
  { tier, monitorOption }: PassPurchaseSelection,
  dates: CustomerUnlimitedStartDates
): readonly string[] => {
  if (tier !== "reserved-desk-workstation") return dates.starts[tier];
  return monitorOption === undefined ? [] : dates.starts[tier][monitorOption];
};

/** Keep a prefill only while it matches an offer and the current capacity. */
export const initializePassSelection = (
  kind: PurchaseKind,
  selection: PassPurchaseSelection,
  catalog: CustomerPassCatalog,
  dates?: CustomerUnlimitedStartDates
): PassPurchaseSelection => {
  const tier =
    (kind === "entry-pack" ? catalog.entryPacks : catalog.unlimited)
      .map(({ product }) => product.tier)
      .find((offered) => offered === selection.tier) ??
    (kind === "entry-pack" ? catalog.entryPacks[0] : catalog.unlimited[0])
      ?.product.tier ??
    selection.tier;
  if (dates === undefined) return { ...selection, tier };
  const { startDate, ...withoutDate } = selection;
  const starts = availableStartDates({ ...selection, tier }, dates);
  if (startDate !== undefined && starts.includes(startDate)) {
    return { ...selection, tier, startDate };
  }
  return starts.includes(dates.today)
    ? { ...withoutDate, tier, startDate: dates.today }
    : { ...withoutDate, tier };
};

export const selectedPassProduct = (
  kind: PurchaseKind,
  choice: PassPurchaseSelection,
  catalog: CustomerPassCatalog,
  dates?: CustomerUnlimitedStartDates
): CustomerPassPurchaseProduct | undefined => {
  const { tier, size, startDate, coffee, monitorOption } = choice;
  if (kind === "entry-pack") {
    return catalog.entryPacks.find(
      ({ product }) => product.tier === tier && product.size === size
    )?.product;
  }
  if (
    dates === undefined ||
    startDate === undefined ||
    !catalog.unlimited.some(({ product }) => product.tier === tier) ||
    !availableStartDates(choice, dates).includes(startDate)
  ) {
    return undefined;
  }

  switch (tier) {
    case "open-space":
      return { kind, selection: { tier, startDate, coffee } };
    case "reserved-desk":
      return { kind, selection: { tier, startDate } };
    case "reserved-desk-workstation":
      return monitorOption === undefined
        ? undefined
        : { kind, selection: { tier, startDate, monitorOption } };
  }
};

export const advertisedPassPrice = (
  kind: PurchaseKind,
  { tier, size, coffee }: PassPurchaseSelection,
  catalog: CustomerPassCatalog
): Money | undefined => {
  if (kind === "entry-pack") {
    return catalog.entryPacks.find(
      ({ product }) => product.tier === tier && product.size === size
    )?.price;
  }
  const price = catalog.unlimited.find(
    ({ product }) => product.tier === tier
  )?.price;
  return price !== undefined && tier === "open-space" && coffee
    ? { ...price, value: price.value + catalog.unlimitedCoffeePrice.value }
    : price;
};
