import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { makePassChangeSchema } from "@deskohub/workspace-domain/features/passes/admin/pass-change";

export {
  passGrantSelectionSchema,
  refundValueSchema,
} from "@deskohub/workspace-domain/features/passes/admin/pass-change";

import { Schema } from "effect";
import { orderIdSchema } from "@/features/order";

export const passChangeSchema = makePassChangeSchema(DotyposCustomerIdSchema);
export type PassChange = typeof passChangeSchema.Type;

export const passChangeRequestIdSchema = Schema.String.check(Schema.isUUID());

const passChangeRequestSchema = Schema.Struct({
  requestId: passChangeRequestIdSchema,
  passId: orderIdSchema,
  change: passChangeSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});

export type PassChangeRequest = Schema.Schema.Type<
  typeof passChangeRequestSchema
>;
