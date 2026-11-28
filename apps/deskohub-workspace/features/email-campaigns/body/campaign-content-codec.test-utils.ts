import { Effect } from "effect";
import { requireValue } from "@/shared/testing/require-value.test-utils";
import type { CampaignBodyDocument } from "./campaign-body-document";
import { readCampaignContent } from "./campaign-content-codec";

/** The body saving stores for a Markdown body, as `dhw` would send it. */
export const markdownCampaignBody = (
  bodyMarkdown: string
): Promise<CampaignBodyDocument> =>
  Effect.runPromise(
    readCampaignContent({
      "cs-CZ": { subject: "", preheader: "", bodyMarkdown },
    }).pipe(
      Effect.map(
        (content) => requireValue(content["cs-CZ"], "cs-CZ content").body
      )
    )
  );
