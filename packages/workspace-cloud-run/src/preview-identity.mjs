import { sha256Hex } from "./sha256.mjs";

export const backendRevisionHeader = "x-deskohub-backend-revision";
export const previewGenerationHeader = "x-deskohub-preview-generation";
export const cloudRunRevisionHeader = "x-deskohub-cloud-run-revision";

/** @param {string} branch */
export const previewBackendBranchTag = (branch) =>
  `b-${sha256Hex(branch).slice(0, 12)}`;

const connectionOverrides = new Set([
  "dbname",
  "host",
  "hostaddr",
  "options",
  "port",
]);

/**
 * Comparison key for the direct and pooled URLs on the same Neon endpoint.
 * @param {string} connectionString
 */
export const previewDatabaseEndpoint = (connectionString) => {
  const url = URL.canParse(connectionString) ? new URL(connectionString) : undefined;
  if (
    !url ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    (url.port !== "" && url.port !== "5432") ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
    !/^\/[^/]+$/.test(url.pathname)
  ) {
    return undefined;
  }
  if (Array.from(url.searchParams.keys()).some((key) => connectionOverrides.has(key.toLowerCase()))) {
    return undefined;
  }
  const endpoint = url.hostname.replace(/-pooler\./, ".");
  return sha256Hex(`${endpoint}${url.pathname}`);
};

/**
 * Contains no credential or provider endpoint. Compare before accepting RPC.
 * @param {{ commitSha: string, deploymentId: string, branchTag: string, databaseEndpoint: string }} binding
 */
export const previewRuntimeGeneration = (binding) =>
  sha256Hex(
    JSON.stringify([
      binding.commitSha,
      binding.deploymentId,
      binding.branchTag,
      binding.databaseEndpoint,
    ])
  );
