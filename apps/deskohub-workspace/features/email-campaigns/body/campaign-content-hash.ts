import { createHash } from "node:crypto";
import type { EmailVersionId } from "@deskohub/workspace-admin-api";
import { CampaignContentHash } from "@deskohub/workspace-domain/features/email-campaigns/campaign-content-hash";
import { canonicalJson } from "@/shared/utils/canonical-json";
import type { CampaignContent } from "./campaign-content";

export { CampaignContentHash } from "@deskohub/workspace-domain/features/email-campaigns/campaign-content-hash";

/**
 * Hashes the subject, preheader, and body of every locale together with the
 * template and purpose. Key order does not affect the hash.
 */
export function hashCampaignContent(
  content: Omit<CampaignContent, "templateKey"> & {
    readonly templateKey: string;
  }
): CampaignContentHash {
  return CampaignContentHash.make(
    createHash("sha256")
      .update(
        canonicalJson({
          purpose: content.purpose,
          templateKey: content.templateKey,
          locales: content.locales,
        })
      )
      .digest("hex")
  );
}

/** The published version is immutable and owns the printed content and values. */
export const hashCampaignEmailVersion = (
  versionId: EmailVersionId
): CampaignContentHash =>
  CampaignContentHash.make(
    createHash("sha256")
      .update(canonicalJson({ publishedEmailVersionId: versionId }))
      .digest("hex")
  );
