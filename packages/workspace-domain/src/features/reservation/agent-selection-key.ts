import { Schema } from "effect";

export const agentSelectionKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand("AgentSelectionKey")
).annotate({
  identifier: "AgentSelectionKey",
  description:
    "Digest of one agent booking request: the account, the agent client, and the complete selection.",
});

export type AgentSelectionKey = typeof agentSelectionKeySchema.Type;
