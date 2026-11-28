import { Schema } from "effect";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { orderIdSchema } from "@/features/order";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import {
  passChangeRequestIdSchema,
  passGrantSelectionSchema,
  refundValueSchema,
} from "./pass-change";

const recipient = {
  email: reservationCustomerEmailSchema,
  recipientName: Schema.optionalKey(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120))
  ),
};

export const passActionInputSchema = Schema.Struct({
  requestId: passChangeRequestIdSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  change: Schema.TaggedUnion({
    grant: { ...recipient, selection: passGrantSelectionSchema },
    reassign: {
      ...recipient,
      passId: orderIdSchema,
      expectedHolderAccountId: customerAccountIdSchema,
      expectedHolderVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    },
    validity: {
      passId: orderIdSchema,
      expectedValidUntil: plainDateStringSchema,
      lastDay: plainDateStringSchema,
      refundValue: refundValueSchema,
    },
    cancel: {
      passId: orderIdSchema,
      expectedValidUntil: plainDateStringSchema,
      refundValue: refundValueSchema,
      sendCancellationEmail: Schema.Boolean,
    },
  }),
});

export type PassActionInput = typeof passActionInputSchema.Encoded;
