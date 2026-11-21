import { Effect, Schema } from "effect";
import {
  getWorkspaceProductByTier,
  getWorkspaceProductCoffeeLinePriceForTier,
  type WorkspaceCoworkProductTier,
  type WorkspaceProductMonitorOption,
  workspaceCoworkTiers,
  workspaceProductWorkstationAddonPrice,
} from "@/features/checkout/product-catalog";
import { getReservationQuoteFingerprint } from "@/features/checkout/reservation-quote-fingerprint";
import { makeReservationQuoteSchema } from "@/features/checkout/reservation-quote-schema";
import type { DiscountQuote } from "@/features/discounts";
import { orderIdSchema } from "@/features/order/order";
import { passTiers } from "@/features/passes/pass-offer";
import {
  type MoneyUnitMismatch,
  moneyCodec,
  moneyWithValue,
  nonNegativeMoneyCodec,
  sumMoney,
} from "@/shared/money/money";

const coworkProductQuoteItemSchema = Schema.Struct({
  type: Schema.Literal("cowork"),
  tier: Schema.Literals(workspaceCoworkTiers),
  amount: moneyCodec,
});

const coworkCoffeeQuoteItemSchema = Schema.Struct({
  type: Schema.Literal("coffee"),
  amount: moneyCodec,
});

const coworkWorkstationQuoteItemSchema = Schema.Struct({
  type: Schema.Literal("workstation"),
  amount: moneyCodec,
});

export const coworkReservationQuoteItemSchema = Schema.Union([
  coworkProductQuoteItemSchema,
  coworkCoffeeQuoteItemSchema,
  coworkWorkstationQuoteItemSchema,
]);

type CoworkProductQuoteItem = typeof coworkProductQuoteItemSchema.Type;
type CoworkCoffeeQuoteItem = typeof coworkCoffeeQuoteItemSchema.Type;
type CoworkWorkstationQuoteItem = typeof coworkWorkstationQuoteItemSchema.Type;

const coworkQuoteSchema = makeReservationQuoteSchema(
  Schema.Union([
    Schema.Tuple([coworkProductQuoteItemSchema]),
    Schema.Tuple([coworkProductQuoteItemSchema, coworkCoffeeQuoteItemSchema]),
    Schema.Tuple([
      coworkProductQuoteItemSchema,
      coworkWorkstationQuoteItemSchema,
    ]),
  ])
);

const coworkEntryPackCoverageSchema = Schema.Struct({
  passId: orderIdSchema,
  tier: Schema.Literals(passTiers),
  coveredAmount: nonNegativeMoneyCodec,
});

export const coworkReservationQuoteSchema = Schema.Struct({
  ...coworkQuoteSchema.fields,
  entryPack: Schema.optionalKey(coworkEntryPackCoverageSchema),
}).annotate({
  identifier: "CoworkReservationQuote",
  description: "Authoritative cowork reservation price quote.",
});

export type CoworkReservationQuote = typeof coworkReservationQuoteSchema.Type;

export type CoworkEntryPackFunding = Pick<
  typeof coworkEntryPackCoverageSchema.Type,
  "passId" | "tier"
>;

type CoworkQuoteOptions =
  | { readonly discountQuote?: DiscountQuote; readonly entryPack?: never }
  | {
      readonly discountQuote?: never;
      readonly entryPack: CoworkEntryPackFunding;
    };

export type CanonicalCoworkReservation = {
  readonly kind: "cowork";
};

/**
 * Accepts every cowork selection shape that reaches a pricing boundary:
 * advertised-price details (workstation presence), normalized orders, and
 * stored details projections (monitor configuration). The canonical cowork
 * `kind` discriminator is mandatory so the input forwards truthfully into
 * the exhaustive cross-family fingerprint dispatch. The chosen monitor
 * configuration never enters the priced quote items.
 */
export type CoworkReservationQuoteInput = {
  readonly kind: "cowork";
  readonly entryTier: WorkspaceCoworkProductTier;
  readonly coffee?: boolean;
  readonly workstation?: boolean;
  readonly monitorOption?: WorkspaceProductMonitorOption | "" | undefined;
};

type CoworkAddonQuoteItem = CoworkCoffeeQuoteItem | CoworkWorkstationQuoteItem;

type CoworkQuoteItems =
  | readonly [CoworkProductQuoteItem]
  | readonly [CoworkProductQuoteItem, CoworkCoffeeQuoteItem]
  | readonly [CoworkProductQuoteItem, CoworkWorkstationQuoteItem];

/**
 * Workstation presence is truthful: an empty or absent monitor option means
 * no workstation was selected, so only an explicit workstation flag or a
 * real, present monitor selection prices the paid add-on.
 */
const getCoworkReservationWorkstationSelected = (
  reservation: CoworkReservationQuoteInput
) =>
  reservation.workstation ??
  (reservation.monitorOption !== undefined && reservation.monitorOption !== "");

const getCoworkCoffeeQuoteItem = (
  tier: WorkspaceCoworkProductTier
): CoworkCoffeeQuoteItem => ({
  type: "coffee",
  amount: getWorkspaceProductCoffeeLinePriceForTier(tier),
});

/**
 * The paid add-on each tier prices. Current tiers price coffee (open space)
 * or a workstation (reserved desk) when selected. Historical tiers keep
 * their original addon composition for decodable legacy quotes: Basic paid
 * for coffee when selected, Plus and Profi had it included.
 */
const coworkAddonQuoteItemByTier: Readonly<
  Record<
    WorkspaceCoworkProductTier,
    (
      reservation: CoworkReservationQuoteInput
    ) => CoworkAddonQuoteItem | undefined
  >
> = {
  "open-space": (reservation) =>
    reservation.coffee ? getCoworkCoffeeQuoteItem("open-space") : undefined,
  "reserved-desk": (reservation) =>
    getCoworkReservationWorkstationSelected(reservation)
      ? { type: "workstation", amount: workspaceProductWorkstationAddonPrice }
      : undefined,
  basic: (reservation) =>
    reservation.coffee ? getCoworkCoffeeQuoteItem("basic") : undefined,
  plus: () => getCoworkCoffeeQuoteItem("plus"),
  profi: () => getCoworkCoffeeQuoteItem("profi"),
};

const getCoworkQuoteItems = (
  productItem: CoworkProductQuoteItem,
  addonItem: CoworkAddonQuoteItem | undefined
): CoworkQuoteItems => {
  if (addonItem === undefined) return [productItem];
  return addonItem.type === "coffee"
    ? [productItem, addonItem]
    : [productItem, addonItem];
};

const priceCoworkQuoteItems = Effect.fn("priceCoworkQuoteItems")(function* (
  items: CoworkQuoteItems,
  discountQuote?: DiscountQuote
) {
  const [productItem, addonItem] = items;
  const addonAmounts = addonItem ? [addonItem.amount] : [];
  const undiscountedPrice = yield* Effect.fromResult(
    sumMoney([productItem.amount, ...addonAmounts])
  );
  const expectedPrice = discountQuote
    ? yield* Effect.fromResult(
        sumMoney([discountQuote.discountedSubtotal, ...addonAmounts])
      )
    : undiscountedPrice;

  return {
    items,
    payment: {
      expectedPrice,
      undiscountedPrice,
      discounts: discountQuote?.discounts ?? [],
    },
  };
});

const priceCoworkEntryPack = Effect.fn("priceCoworkEntryPack")(function* (
  items: CoworkQuoteItems,
  entryPack: CoworkEntryPackFunding
) {
  const [productItem, addonItem] = items;
  const zero = moneyWithValue(0, productItem.amount);
  const includedWorkstation =
    entryPack.tier === "reserved-desk-workstation" &&
    addonItem?.type === "workstation";
  const coveredAmount = includedWorkstation
    ? yield* Effect.fromResult(sumMoney([productItem.amount, addonItem.amount]))
    : productItem.amount;
  const priced = yield* priceCoworkQuoteItems(
    getCoworkQuoteItems(
      { ...productItem, amount: zero },
      includedWorkstation ? { ...addonItem, amount: zero } : addonItem
    )
  );
  return {
    ...priced,
    entryPack: {
      passId: entryPack.passId,
      tier: entryPack.tier,
      coveredAmount,
    },
  };
});

export const getCoworkReservationQuote = Effect.fn("getCoworkReservationQuote")(
  (
    reservation: CoworkReservationQuoteInput,
    options: CoworkQuoteOptions = {}
  ): Effect.Effect<
    Omit<CoworkReservationQuote, "fingerprint">,
    MoneyUnitMismatch
  > => {
    const items = getCoworkQuoteItems(
      {
        type: "cowork",
        tier: reservation.entryTier,
        amount: getWorkspaceProductByTier(reservation.entryTier).price,
      },
      coworkAddonQuoteItemByTier[reservation.entryTier](reservation)
    );
    return options.entryPack
      ? priceCoworkEntryPack(items, options.entryPack)
      : priceCoworkQuoteItems(items, options.discountQuote);
  }
);

export const buildCoworkReservationQuote = Effect.fn(
  "buildCoworkReservationQuote"
)(function* (
  reservation: CoworkReservationQuoteInput,
  options: CoworkQuoteOptions = {}
) {
  // The cross-family fingerprint dispatcher would silently accept another
  // family's kind while this builder still prices cowork items, so reject
  // any runtime kind other than "cowork" at this boundary.
  if (reservation.kind !== "cowork") {
    return yield* Effect.die(
      new Error("Cowork reservation quote requires the canonical cowork kind.")
    );
  }

  const quoteWithoutFingerprint = yield* getCoworkReservationQuote(
    reservation,
    options
  );

  return {
    ...quoteWithoutFingerprint,
    fingerprint: getReservationQuoteFingerprint(
      reservation,
      quoteWithoutFingerprint
    ),
  };
});
