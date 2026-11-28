import { Schema } from "effect";
import { currencyCZK } from "../../shared/money/currencies";
import { workspaceSiteConstants } from "../../shared/utils/site-constants";
import {
  type PlainDate,
  plainDateStringSchema,
  temporalInstantToPlainDate,
} from "../../shared/utils/temporal";

export const passTiers = [
  "open-space",
  "reserved-desk",
  "reserved-desk-workstation",
] as const;
const passTierSchema = Schema.Literals(passTiers);
export type PassTier = typeof passTierSchema.Type;

const entryPackSizes = [5, 10] as const;
const entryPackSizeSchema = Schema.Literals(entryPackSizes);
export type EntryPackSize = typeof entryPackSizeSchema.Type;

export const entryPackProductSchema = Schema.Struct({
  kind: Schema.Literal("entry-pack"),
  tier: passTierSchema,
  size: entryPackSizeSchema,
});
export type EntryPackProduct = typeof entryPackProductSchema.Type;

export const unlimitedPassProductSchema = Schema.Struct({
  kind: Schema.Literal("unlimited"),
  tier: passTierSchema,
});
export type UnlimitedPassProduct = typeof unlimitedPassProductSchema.Type;

export const entryPackProductKeySchema = Schema.TemplateLiteral([
  "entry-pack:",
  passTierSchema,
  ":",
  entryPackSizeSchema,
]);
export const unlimitedPassProductKeySchema = Schema.TemplateLiteral([
  "unlimited:",
  passTierSchema,
]);

export type PassProduct = EntryPackProduct | UnlimitedPassProduct;

export const getPassProductKey = (product: PassProduct) =>
  product.kind === "entry-pack"
    ? entryPackProductKeySchema.make(
        `entry-pack:${product.tier}:${product.size}`
      )
    : unlimitedPassProductKeySchema.make(`unlimited:${product.tier}`);

const entryPackPrices = {
  "open-space": { 5: 1150, 10: 2190 },
  "reserved-desk": { 5: 1590, 10: 3090 },
  "reserved-desk-workstation": { 5: 2050, 10: 3990 },
} as const;
const entryPackMonths = { 5: 2, 10: 3 } as const;
const unlimitedPassPrices = {
  "open-space": 3490,
  "reserved-desk": 5990,
  "reserved-desk-workstation": 8490,
} as const;
export const unlimitedPassDays = 30;
export const unlimitedPassCoffeePrice = currencyCZK(690 * 100);

export const getEntryPackPrice = ({ tier, size }: EntryPackProduct) =>
  currencyCZK(entryPackPrices[tier][size] * 100);

export const getUnlimitedPassPrice = ({ tier }: UnlimitedPassProduct) =>
  currencyCZK(unlimitedPassPrices[tier] * 100);

export const entryPackOffers = passTiers.flatMap((tier) =>
  entryPackSizes.map((size) => ({
    product: entryPackProductSchema.make({ kind: "entry-pack", tier, size }),
    price: getEntryPackPrice({ kind: "entry-pack", tier, size }),
    validityMonths: entryPackMonths[size],
  }))
);

export const unlimitedPassOffers = passTiers.map((tier) => {
  const product = unlimitedPassProductSchema.make({ kind: "unlimited", tier });
  return {
    product,
    price: getUnlimitedPassPrice(product),
    validityDays: unlimitedPassDays,
  };
});

const entryPackLocalDate = (instant: Temporal.Instant) =>
  temporalInstantToPlainDate({
    instant,
    timeZone: workspaceSiteConstants.location.timeZone,
  });

export const isEntryPackQuoteExpired = (
  now: Temporal.Instant,
  validUntil: typeof plainDateStringSchema.Type
) => Temporal.PlainDate.compare(entryPackLocalDate(now), validUntil) >= 0;

export const getEntryPackEndDate = (
  startDate: PlainDate,
  size: EntryPackSize
) =>
  plainDateStringSchema.make(
    Temporal.PlainDate.from(startDate)
      .add({ months: entryPackMonths[size] })
      .toString()
  );

export const getEntryPackValidity = (
  purchasedAt: Temporal.Instant,
  size: EntryPackSize
) => {
  const validFrom = plainDateStringSchema.make(
    entryPackLocalDate(purchasedAt).toString()
  );
  return {
    validFrom,
    validUntil: getEntryPackEndDate(validFrom, size),
  };
};

/** The last Prague date covered by the pack's exclusive expiry boundary. */
export const getEntryPackLastUsableDate = (validUntil: string) =>
  Temporal.PlainDate.from(validUntil).subtract({ days: 1 });
