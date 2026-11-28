const frontendOnlyPrefix = "apps/deskohub-workspace/";
const frontendManifest = `${frontendOnlyPrefix}package.json`;

// The production image builds from the repository root and uses Turbo's
// transitive workspace closure. Unknown paths must require a generation.
export function backendGenerationRequired(changedPaths) {
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some(
      (path) =>
        typeof path !== "string" ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject workflow-unsafe path characters.
        /[\\\x00-\x1f\x7f]/.test(path) ||
        path
          .split("/")
          .some((part) => part === "" || part === "." || part === ".."),
    )
  ) {
    throw new TypeError("Expected a complete list of canonical changed paths.");
  }
  return changedPaths.some(
    (path) => path === frontendManifest || !path.startsWith(frontendOnlyPrefix),
  );
}
