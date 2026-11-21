import {
  type AdministrationCustomerVoucherCreateInput,
  AdministrationDiscountCodeCreateInput,
  type AdministrationDiscountCodeUpdateInput,
  AdministrationDiscountDefinitionInput,
  AdministrationDiscountMutation,
  AdministrationDiscountUpdateInput,
  type AdministrationExistingDiscountCodeCreateInput,
  type AdministrationVoucherCreateInput,
  type AdministrationVoucherUpdateInput,
} from "@deskohub/workspace-admin-api";
import { Schema } from "effect";
import {
  findWorkspaceProductTargetsIssue,
  workspaceProductTargetSchema,
} from "../product-target";

const discountProducts = Schema.NonEmptyArray(
  workspaceProductTargetSchema
).check(Schema.makeFilter(findWorkspaceProductTargetsIssue));

const discountDefinition = Schema.Struct({
  ...AdministrationDiscountDefinitionInput.fields,
  products: discountProducts,
});

// Tag fresh unions so the released v1 schemas are left untouched.
const v1Selections = Schema.Union(
  AdministrationDiscountCodeCreateInput.fields.discount.members
).pipe(Schema.toTaggedUnion("kind")).cases;

const discountSelection = Schema.Union(
  Object.values({
    ...v1Selections,
    new: Schema.Struct({
      ...v1Selections.new.fields,
      discount: discountDefinition,
    }),
  })
);

const v1Mutations = Schema.Union(AdministrationDiscountMutation.members).pipe(
  Schema.toTaggedUnion("kind")
).cases;

export const discountAdminMutationSchema = Schema.Union(
  Object.values({
    ...v1Mutations,
    "create-discount": Schema.Struct({
      ...v1Mutations["create-discount"].fields,
      discount: discountDefinition,
    }),
    "update-discount": Schema.Struct({
      ...v1Mutations["update-discount"].fields,
      discount: Schema.Struct({
        ...AdministrationDiscountUpdateInput.fields,
        products: discountProducts,
      }),
    }),
    "create-code": Schema.Struct({
      ...v1Mutations["create-code"].fields,
      discount: discountSelection,
    }),
    "create-customer-code": Schema.Struct({
      ...v1Mutations["create-customer-code"].fields,
      discount: discountSelection,
    }),
  })
);

export const discountAdminMutationStandardSchema = Schema.toStandardSchemaV1(
  discountAdminMutationSchema,
  {
    parseOptions: {
      errors: "all",
      onExcessProperty: "error",
    },
  }
);

export type DiscountAdminMutation = typeof discountAdminMutationSchema.Type;
type DiscountMutation<Kind extends DiscountAdminMutation["kind"]> = Extract<
  DiscountAdminMutation,
  { readonly kind: Kind }
>;

export type CreateDiscountAdminInput =
  DiscountMutation<"create-discount">["discount"];
export type UpdateDiscountAdminInput =
  DiscountMutation<"update-discount">["discount"];
export type CreateDiscountCodeAdminInput =
  typeof AdministrationExistingDiscountCodeCreateInput.Type;
export type CreateManagedDiscountCodeAdminInput = Omit<
  DiscountMutation<"create-code">,
  "kind"
>;
export type CreateCustomerDiscountCodeAdminInput = Omit<
  DiscountMutation<"create-customer-code">,
  "kind"
>;
export type UpdateDiscountCodeAdminInput =
  typeof AdministrationDiscountCodeUpdateInput.Type;
export type CreateVoucherAdminInput =
  typeof AdministrationVoucherCreateInput.Type;
export type CreateCustomerVoucherAdminInput =
  typeof AdministrationCustomerVoucherCreateInput.Type;
export type UpdateVoucherAdminInput =
  typeof AdministrationVoucherUpdateInput.Type;
