import {
  NexiOperationIdSchema,
  NexiOrderIdSchema,
  type NexiService,
} from "@deskohub/nexi";
import type { Effect } from "effect";

export type NexiVerification = Effect.Success<
  ReturnType<typeof NexiService.Service.verifyPaymentOutcome>
>;

export const nexiVerificationFixture = (
  status: NexiVerification["status"],
  overrides: Partial<NexiVerification["provider"]> = {},
  mismatches: NexiVerification["mismatches"] = []
): NexiVerification => ({
  status,
  provider: {
    orderId: NexiOrderIdSchema.make("provider-order-id"),
    operationId: NexiOperationIdSchema.make("operation-id"),
    operationCount: 1,
    amount: "35000",
    currency: "CZK",
    authorizedAmount: undefined,
    capturedAmount: undefined,
    orderStatus: status === "failure" ? "DECLINED" : "EXECUTED",
    captureExecuted: status === "success",
    ...overrides,
  },
  mismatches,
});
