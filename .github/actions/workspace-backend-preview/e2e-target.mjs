import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyPullRequestTarget, verifyVercel } from "./target.mjs";

export function originFromE2EEvent(raw, environment) {
  const value = environment.GITHUB_EVENT_NAME === "workflow_dispatch"
    ? raw.inputs?.url
    : raw.client_payload?.url;
  const candidate = new URL(value);
  const digest = createHash("sha256").update(candidate.origin).digest("hex");
  if (digest !== environment.TARGET_URL_DIGEST) {
    throw new Error("The backend gate does not match the validated E2E deployment");
  }
  return candidate.origin;
}

export async function readValidatedE2EOrigin(environment) {
  const event = JSON.parse(await readFile(environment.GITHUB_EVENT_PATH, "utf8"));
  return originFromE2EEvent(event, environment);
}

export function targetFromE2EEnvironment(environment) {
  const number = Number(environment.PR_NUMBER);
  if (!/^[1-9][0-9]*$/.test(environment.PR_NUMBER ?? "") || !Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(environment.TARGET_SHA ?? "")) {
    throw new Error("Expected the validated pilot PR and its full head SHA");
  }
  return {
    operation: "deploy",
    number,
    sha: environment.TARGET_SHA,
  };
}

async function main() {
  const target = targetFromE2EEnvironment(process.env);
  const environment = { ...process.env, GIT_REF: process.env.TARGET_REF };
  switch (process.argv[2]) {
    case "classify": {
      const { backendRequired } = await classifyPullRequestTarget(target, environment);
      process.stdout.write(`${backendRequired}\n`);
      return;
    }
    case "deployment": {
      const expectedOrigin = await readValidatedE2EOrigin(environment);
      const { deploymentId } = await verifyVercel({
        ...target,
        expectedOrigin,
      }, environment);
      if (!process.env.GITHUB_OUTPUT || !process.env.RUNNER_TEMP) throw new Error("GitHub outputs are unavailable");
      await writeFile(join(process.env.RUNNER_TEMP, "workspace-backend-preview-origin"), expectedOrigin, { mode: 0o600, flag: "wx" });
      await appendFile(process.env.GITHUB_OUTPUT, `deployment_id=${deploymentId}\n`);
      return;
    }
    default:
      throw new Error("Unknown backend preview target operation");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Could not verify the Workspace backend preview target.\n");
    process.exitCode = 1;
  });
}
