import { Data, Effect, Schema } from "effect";
import type {
  DiscountLabels,
  DiscountProductTarget,
  StoredDiscount,
} from "@/db/schema";
import {
  findWorkspaceProductTargetsIssue,
  type WorkspaceProductTarget,
  workspaceProductTargetSchema,
} from "@/features/discounts/product-target";
import { type DiscountAdjustment, discountAdjustmentSchema } from "./contracts";
import { discountLabelLocales } from "./discount-label";
import {
  type StoredDiscountId,
  storedDiscountIdSchema,
} from "./persistence-contracts";

export type DiscountDefinition = {
  readonly id: StoredDiscountId;
  readonly labels: DiscountLabels;
  readonly adjustment: DiscountAdjustment;
  readonly products: readonly WorkspaceProductTarget[];
};

type StoredDiscountTarget = Pick<
  DiscountProductTarget,
  "discountId" | "productTarget"
>;

export type DiscountDefinitionRow = Omit<StoredDiscount, "labels"> & {
  readonly labels: unknown;
  readonly productTargets: readonly {
    readonly discountId: StoredDiscountTarget["discountId"];
    readonly productTarget: unknown;
  }[];
};

export class DiscountDefinitionMalformedError extends Data.TaggedError(
  "DiscountDefinitionMalformedError"
)<{
  readonly discountId: StoredDiscountId;
  readonly message: string;
  readonly cause: unknown;
}> {}

export const decodeDiscountDefinition = Effect.fn("DiscountDefinition.decode")(
  (input: {
    readonly row: DiscountDefinitionRow;
  }): Effect.Effect<DiscountDefinition, DiscountDefinitionMalformedError> =>
    Effect.succeed(input).pipe(
      Effect.let("id", ({ row }) => row.id),
      Effect.bind("labels", decodeDefinitionLabels),
      Effect.bind("adjustment", decodeStoredDiscountAdjustment),
      Effect.bind("targets", decodeDefinitionTargets),
      Effect.let("products", ({ targets }) =>
        targets.map(({ productTarget }) => productTarget)
      ),
      Effect.mapError(
        (cause) =>
          new DiscountDefinitionMalformedError({
            discountId: input.row.id,
            message: "Stored discount definition is malformed.",
            cause,
          })
      )
    )
);

const definitionLabelSchema = Schema.Trim.check(Schema.isNonEmpty());

const discountLabelsCodec: Schema.Decoder<DiscountLabels> = Schema.Record(
  Schema.Literals(discountLabelLocales),
  definitionLabelSchema
);

const discountTargetSchema: Schema.Decoder<StoredDiscountTarget> =
  Schema.Struct({
    discountId: storedDiscountIdSchema,
    productTarget: workspaceProductTargetSchema,
  });

const discountTargetsSchema = (discountId: StoredDiscountId) =>
  Schema.NonEmptyArray(discountTargetSchema).check(
    Schema.makeFilter(
      (targets) =>
        targets.every((target) => target.discountId === discountId) || {
          path: [],
          issue: "product targets must belong to the discount definition",
        }
    ),
    Schema.makeFilter((targets) => {
      const issue = findWorkspaceProductTargetsIssue(
        targets.map(({ productTarget }) => productTarget)
      );
      return issue === undefined || { path: [], issue };
    })
  );

const decodeDefinitionLabels = (input: {
  readonly row: DiscountDefinitionRow;
}) =>
  Schema.decodeUnknownEffect(discountLabelsCodec, {
    errors: "all",
    onExcessProperty: "error",
  })(input.row.labels);

/** The columns that hold a stored discount's adjustment. */
export type StoredDiscountAdjustment = Pick<
  StoredDiscount,
  | "fixedAmountCurrency"
  | "fixedAmountExponent"
  | "fixedAmountValue"
  | "percentageBasisPoints"
>;

/**
 * A stored discount's adjustment: its percentage when it has one, else its
 * fixed amount.
 */
export const decodeStoredDiscountAdjustment = (input: {
  readonly row: StoredDiscountAdjustment;
}) =>
  Schema.decodeUnknownEffect(discountAdjustmentSchema, {
    errors: "all",
    onExcessProperty: "error",
  })(
    input.row.percentageBasisPoints === null
      ? {
          kind: "fixed",
          amount: {
            value: input.row.fixedAmountValue,
            exponent: input.row.fixedAmountExponent,
            currency: input.row.fixedAmountCurrency,
          },
        }
      : {
          kind: "percentage",
          basisPoints: input.row.percentageBasisPoints,
        }
  );

const decodeDefinitionTargets = (input: {
  readonly row: DiscountDefinitionRow;
}) =>
  Schema.decodeUnknownEffect(discountTargetsSchema(input.row.id), {
    errors: "all",
    onExcessProperty: "error",
  })(input.row.productTargets);
