import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { Schema } from "effect";
import { orderIdSchema } from "@/features/order";
import { moneyCodec } from "@/shared/money/money";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { passStatuses } from "../pass";
import { entryPackProductSchema, passTiers } from "../pass-offer";

export const adminPassProducts = ["entry-pack", "unlimited"] as const;
export const adminPassSources = ["paid", "gift", "complimentary"] as const;
export const adminPassStatuses = [...passStatuses, "scheduled"] as const;
export type AdminPassStatus = (typeof adminPassStatuses)[number];

export const adminPassSearchLimit = 256;
export const adminPassPageSize = 25;

export const adminPassListInput = Schema.Struct({
  product: Schema.optionalKey(Schema.Literals(adminPassProducts)),
  tier: Schema.optionalKey(Schema.Literals(passTiers)),
  status: Schema.optionalKey(Schema.Literals(adminPassStatuses)),
  source: Schema.optionalKey(Schema.Literals(adminPassSources)),
  query: Schema.optionalKey(
    Schema.Trim.check(
      Schema.isMinLength(2),
      Schema.isMaxLength(adminPassSearchLimit)
    )
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))
  ),
});

export type AdminPassListInput = typeof adminPassListInput.Type;

const adminPassParty = Schema.Struct({
  customerId: Schema.NullOr(DotyposCustomerIdSchema),
  name: Schema.NullOr(
    Schema.Struct({
      displayName: Schema.String,
      hasName: Schema.Boolean,
      lifecycle: Schema.Literals(["active", "deleted", "expired"]),
    })
  ),
  email: Schema.NullOr(Schema.String),
  deleted: Schema.Boolean,
});

const adminPassSummary = Schema.Struct({
  id: orderIdSchema,
  product: Schema.Literals(adminPassProducts),
  tier: Schema.Literals(passTiers),
  entryCount: Schema.NullOr(entryPackProductSchema.fields.size),
  entriesLeft: Schema.NullOr(Schema.Int),
  status: Schema.Literals(adminPassStatuses),
  validFrom: plainDateStringSchema,
  validUntil: plainDateStringSchema,
  accessEndsOn: Schema.NullOr(plainDateStringSchema),
  day: Schema.NullOr(Schema.Int),
  complimentary: Schema.Boolean,
  claimed: Schema.NullOr(Schema.Boolean),
  holder: adminPassParty,
  buyer: Schema.NullOr(adminPassParty),
  paid: Schema.NullOr(moneyCodec),
});

export const adminPassPage = Schema.Struct({
  passes: Schema.Array(adminPassSummary),
  total: Schema.Int,
  hasNextPage: Schema.Boolean,
  searchIncomplete: Schema.Boolean,
});

export type AdminPassParty = typeof adminPassParty.Type;
export type AdminPassSummary = typeof adminPassSummary.Type;
export type AdminPassPage = typeof adminPassPage.Type;
