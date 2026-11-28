import { Data } from "effect";
import type { BetterAuthSecretsMessage } from "../../shared/credentials/versioned-secrets";

export class CampaignSigningKeyInvalid extends Data.TaggedError(
  "CampaignSigningKeyInvalid"
)<{
  readonly message: BetterAuthSecretsMessage;
}> {}

export class CampaignUnsubscribeTokenInvalid extends Data.TaggedError(
  "CampaignUnsubscribeTokenInvalid"
) {}
