import { Schema } from "effect";
import { plainDateStringSchema } from "../../shared/utils/temporal";
import { workspaceProductMonitorOptions } from "../checkout/product-catalog";

export const periodFields = { startDate: plainDateStringSchema };

export const unlimitedPassSelectionSchema = Schema.Union([
  Schema.Struct({
    ...periodFields,
    tier: Schema.Literal("open-space"),
    coffee: Schema.Boolean,
  }),
  Schema.Struct({ ...periodFields, tier: Schema.Literal("reserved-desk") }),
  Schema.Struct({
    ...periodFields,
    tier: Schema.Literal("reserved-desk-workstation"),
    monitorOption: Schema.Literals(workspaceProductMonitorOptions),
  }),
]);
