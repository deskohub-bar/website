import { Schema } from "effect";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { orderIdSchema } from "@/features/order";
import type { EmailKind } from "@/shared/backend/email/email-kind";

const metadata = Schema.Struct({
  orderId: orderIdSchema,
  paymentAttemptId: paymentAttemptIdSchema,
});

export const unlimitedConfirmationEmailKind = {
  category: "unlimited_pass_purchase",
  metadata: Schema.toStandardSchemaV1(metadata),
} satisfies EmailKind<typeof metadata.Type>;
