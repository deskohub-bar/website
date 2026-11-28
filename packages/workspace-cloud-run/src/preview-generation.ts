import * as Schema from "effect/Schema";

export {
  backendRevisionHeader,
  cloudRunRevisionHeader,
  previewBackendBranchTag,
  previewDatabaseEndpoint,
  previewGenerationHeader,
  previewRuntimeGeneration,
} from "./preview-identity.mjs";

export const PreviewCommitSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}$/)
);
export const PreviewDeploymentId = Schema.String.check(
  Schema.isPattern(/^dpl_[A-Za-z0-9]{1,64}$/)
);
export const PreviewNeonBranchId = Schema.String.check(
  Schema.isPattern(/^br-[a-z0-9-]{1,60}$/)
);

/** Use the Cloud Run service origin as the audience for all of its tags. */
export const taggedCloudRunOrigin = (serviceOrigin: string, tag: string) => {
  const url = URL.parse(serviceOrigin);
  if (
    url?.origin !== serviceOrigin ||
    url.protocol !== "https:" ||
    url.port ||
    !/^[a-z0-9.-]+\.run\.app$/.test(url.hostname) ||
    url.hostname.includes("---") ||
    !/^[a-z][a-z0-9-]{0,24}$/.test(tag)
  ) {
    return undefined;
  }
  const hostname = `${tag}---${url.hostname}`;
  return hostname.split(".").every((label) => label.length <= 63)
    ? `https://${hostname}`
    : undefined;
};

export const PreviewRuntimeBinding = Schema.Struct({
  commitSha: PreviewCommitSha,
  deploymentId: PreviewDeploymentId,
  branchTag: Schema.String.check(Schema.isPattern(/^(b-[0-9a-f]{12}|main)$/)),
  databaseEndpoint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type PreviewRuntimeBinding = typeof PreviewRuntimeBinding.Type;
