import "server-only";

import {
  type MarketingConsentRecord,
  type IMarketingConsentLedger as StoredMarketingConsent,
  MarketingConsentLedger as StoredMarketingConsentLedger,
} from "@deskohub/workspace-backend/features/legal/backend/marketing-consent-ledger";
import { Context, Effect, Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { getLegalDocumentVersion } from "../document-version";

export {
  type CustomerMarketingConsent,
  type MarketingConsentRecord,
  MarketingConsentUnavailable,
  marketingConsentState,
} from "@deskohub/workspace-backend/features/legal/backend/marketing-consent-ledger";

export interface IMarketingConsentLedger
  extends Omit<StoredMarketingConsent, "record"> {
  readonly record: (
    input: MarketingConsentRecord
  ) => ReturnType<StoredMarketingConsent["record"]>;
}

export class MarketingConsentLedger extends Context.Service<
  MarketingConsentLedger,
  IMarketingConsentLedger
>()("@deskohub-workspace/legal/MarketingConsentLedger") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const ledger = yield* StoredMarketingConsentLedger;
      return {
        ...ledger,
        record: (input) =>
          Effect.suspend(() =>
            ledger.record({
              ...input,
              documentHash: getLegalDocumentVersion(
                input.locale,
                "marketing-communications"
              ),
            })
          ),
      };
    })
  ).pipe(Layer.provide(StoredMarketingConsentLedger.Default));

  static Live = this.Default.pipe(Layer.provide(WorkspaceDatabase.Default));
}
