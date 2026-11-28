import { Schema } from "effect";

export const customerAgentClientIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CustomerAgentClientId")
).annotate({
  identifier: "CustomerAgentClientId",
  description:
    "OAuth client ID of a customer's AI agent: its Client ID Metadata Document URL.",
});

export type CustomerAgentClientId = typeof customerAgentClientIdSchema.Type;
