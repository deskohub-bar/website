import { Schema } from "effect";
import type { passPurchases } from "@/db/schema";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import { orderIdSchema } from "@/features/order";
import type { EmailKind } from "@/shared/backend/email/email-kind";

const metadata = Schema.Struct({
  orderId: orderIdSchema,
  paymentAttemptId: paymentAttemptIdSchema,
});

const confirmationMetadata = Schema.toStandardSchemaV1(metadata);

export const passConfirmationEmailKinds = {
  "entry-pack": {
    category: "entry_pack_purchase",
    metadata: confirmationMetadata,
  },
  unlimited: {
    category: "unlimited_pass_purchase",
    metadata: confirmationMetadata,
  },
} satisfies Record<
  (typeof passPurchases.$inferSelect)["product"],
  EmailKind<typeof metadata.Type>
>;
