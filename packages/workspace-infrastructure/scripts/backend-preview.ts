import { fileURLToPath } from "node:url";
import {
  PreviewCommitSha,
  PreviewNeonBranchId,
  previewBackendBranchTag,
  previewDatabaseEndpoint,
} from "@deskohub/workspace-cloud-run/preview-generation";
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  canResumePreviewSeed,
  PreviewServiceReadback,
  type PreviewSnapshot,
  previewSnapshotFence,
  requireOwnedServices,
  resolvePreviewServiceOrigin,
  verifyPreviewRouting,
  versionFromAppliedCandidate,
} from "../src/preview/preview-deployment";
import {
  PreviewCandidate,
  type PreviewRole,
  PreviewTarget,
  previewDatabaseSecret,
  previewImageRepository,
  previewProject,
  previewRegion,
  previewRevision,
  previewRoles,
  previewServices,
  previewStage,
  previewWorkerTag,
} from "../src/preview/preview-services";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const alchemy = fileURLToPath(
  new URL("../node_modules/.bin/alchemy", import.meta.url)
);
const servicesUrl = `https://run.googleapis.com/v2/projects/${previewProject}/locations/${previewRegion}/services`;
const repositoryUrl = "https://api.github.com/repos/Deskohub/deskohub-site";

const Pilot = Schema.Struct({
  pr: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,9}$/)),
  sha: PreviewCommitSha,
  ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  neonBranch: PreviewNeonBranchId,
});
type Pilot = typeof Pilot.Type;
type PreviewRequest = (url: string, options: RequestInit) => Promise<Response>;

const Pull = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  head: Schema.Struct({
    ref: Schema.String,
    sha: PreviewCommitSha,
    repo: Schema.Struct({ id: Schema.Literal(1015951989) }),
  }),
});

const ServiceList = Schema.Struct({
  services: Schema.optional(
    Schema.Array(
      Schema.Struct({
        trafficStatuses: Schema.optional(
          Schema.Array(
            Schema.Struct({
              tag: Schema.optional(Schema.String),
            })
          )
        ),
      })
    )
  ),
  nextPageToken: Schema.optional(Schema.String),
});

const SecretVersions = Schema.Array(
  Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/\/versions\/[1-9][0-9]*$/)),
    state: Schema.Literals(["ENABLED", "DISABLED", "DESTROYED"]),
  })
);

const RegistryImages = Schema.Array(
  Schema.Struct({
    version: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  })
);

const InvokerPolicy = Schema.Struct({
  bindings: Schema.optional(
    Schema.Array(
      Schema.Struct({
        members: Schema.Array(Schema.String),
      })
    )
  ),
});

const parse = <S extends Schema.Decoder<unknown, never>>(
  schema: S,
  message: string
) =>
  flow(
    Schema.decodeUnknownOption(schema),
    Option.getOrThrowWith(() => new Error(message))
  );

const authenticatedRequest = (
  url: string,
  token: string,
  request: PreviewRequest = fetch
) =>
  request(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Deskohub-Workspace-Backend-Preview",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

export const checkPilotHead = async (
  pilot: Pilot,
  state: "open" | "closed",
  request: PreviewRequest = fetch,
  token = process.env.GH_TOKEN
) => {
  if (!token) {
    throw new Error("GitHub read credentials are required for the pilot fence");
  }
  const response = await authenticatedRequest(
    `${repositoryUrl}/pulls/${pilot.pr}`,
    token,
    request
  );
  if (!response.ok) {
    throw new Error("Could not verify the pilot pull request");
  }
  const pull = parse(
    Pull,
    "Pilot pull request is not internal"
  )(await response.json());
  if (
    pull.state !== state ||
    (state === "open" && pull.draft) ||
    pull.head.ref !== pilot.ref ||
    pull.head.sha !== pilot.sha
  ) {
    throw new Error("Pilot pull request moved or changed state");
  }
};

const cloudRunRead = async (path: string) => {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token || process.env.GOOGLE_PROJECT_ID !== previewProject) {
    throw new Error(
      "Preview Google Cloud credentials are missing or target another project"
    );
  }
  return authenticatedRequest(`${servicesUrl}${path}`, token);
};

const checkPrivateServices = async () => {
  await Promise.all(
    previewRoles.map(async (role) => {
      const response = await cloudRunRead(
        `/${previewServices[role]}:getIamPolicy`
      );
      if (!response.ok)
        throw new Error(`Could not verify the ${role} preview invoker policy`);
      const policy = parse(
        InvokerPolicy,
        "Invalid preview invoker policy"
      )(await response.json());
      if (
        policy.bindings?.some((binding) =>
          binding.members.some(
            (member) =>
              member === "allUsers" || member === "allAuthenticatedUsers"
          )
        )
      ) {
        throw new Error(`The ${role} preview service has a public IAM binding`);
      }
    })
  );
};

const readService = async (role: PreviewRole) => {
  const response = await cloudRunRead(`/${previewServices[role]}`);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Could not read the ${role} preview service`);
  }
  return parse(
    PreviewServiceReadback,
    "Invalid preview service readback"
  )(await response.json());
};

const readSnapshot = async (): Promise<PreviewSnapshot> => {
  const readings = await Promise.all(
    previewRoles.map(async (role) => ({
      role,
      service: await readService(role),
    }))
  );
  const snapshot = new Map<PreviewRole, PreviewServiceReadback>();
  for (const { role, service } of readings) {
    if (service) {
      snapshot.set(role, service);
    }
  }
  return snapshot;
};

// Reserve room for unrelated sandbox work before Cloud Run reaches its regional
// tag quota and silently drops older no-traffic tags.
const checkTagCapacity = async () => {
  let tags = 0;
  let next = "";
  do {
    const response = await cloudRunRead(
      `?pageSize=100&pageToken=${encodeURIComponent(next)}`
    );
    if (!response.ok) {
      throw new Error("Could not confirm Cloud Run preview tag capacity");
    }
    const page = parse(
      ServiceList,
      "Invalid regional Cloud Run inventory"
    )(await response.json());
    for (const service of page.services ?? []) {
      tags += service.trafficStatuses?.filter((entry) => entry.tag).length ?? 0;
    }
    if (tags + previewRoles.length > 1980) {
      throw new Error("Cloud Run preview tag capacity is exhausted");
    }
    next = page.nextPageToken ?? "";
  } while (next);
};

// Keep secrets out of command arguments, Alchemy state, and provider diagnostics.
const run = async (
  args: string[],
  message: string,
  input?: string,
  target?: PreviewTarget
) => {
  const { PREVIEW_DATABASE_URL, GH_TOKEN, ...environment } = process.env;
  const child = Bun.spawn(args, {
    cwd: packageRoot,
    env: {
      ...environment,
      WORKSPACE_PREVIEW_TARGET: target && JSON.stringify(target),
    },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(message);
  }
  return output.trim();
};

const gcloud = (args: string[], message: string, input?: string) =>
  run(
    ["gcloud", ...args, `--project=${previewProject}`, "--quiet"],
    message,
    input
  );

const applyStack = (command: "deploy" | "destroy", target?: PreviewTarget) =>
  run(
    [
      alchemy,
      command,
      "backend-preview.alchemy.ts",
      "--stage",
      previewStage,
      "--yes",
      "--no-input",
    ],
    `Alchemy preview ${command} failed`,
    undefined,
    target
  );

const addDatabaseVersion = (url: string) =>
  gcloud(
    [
      "secrets",
      "versions",
      "add",
      previewDatabaseSecret,
      "--data-file=-",
      "--format=value(name.basename())",
    ],
    "Could not add the preview database secret version",
    url
  );

const purgeDatabaseVersions = async () => {
  const values = await gcloud(
    ["secrets", "versions", "list", previewDatabaseSecret, "--format=json"],
    "Could not list preview database secret versions"
  );
  const versions = parse(
    SecretVersions,
    "Invalid preview secret version inventory"
  )(JSON.parse(values));
  for (const version of versions) {
    if (version.state !== "DESTROYED") {
      const number = version.name.split("/").at(-1) ?? "";
      await gcloud(
        [
          "secrets",
          "versions",
          "destroy",
          number,
          `--secret=${previewDatabaseSecret}`,
        ],
        "Could not destroy a preview database secret version"
      );
    }
  }
};

const purgeImages = async () => {
  const values = await gcloud(
    [
      "artifacts",
      "docker",
      "images",
      "list",
      previewImageRepository,
      "--format=json",
    ],
    "Could not list preview images"
  );
  const images = parse(
    RegistryImages,
    "Invalid preview image inventory"
  )(JSON.parse(values));
  for (const image of images) {
    await gcloud(
      [
        "artifacts",
        "docker",
        "images",
        "delete",
        `${previewImageRepository}@${image.version}`,
        "--delete-tags",
      ],
      "Could not delete a preview image"
    );
  }
};

const deploy = async (pilot: Pilot) => {
  await checkPilotHead(pilot, "open");
  const services = await readSnapshot();
  requireOwnedServices(services, pilot.pr, pilot.neonBranch);
  const workerBaseOrigin = resolvePreviewServiceOrigin(
    "tasks-worker",
    services.get("tasks-worker")
  );
  const databaseUrl = process.env.PREVIEW_DATABASE_URL;
  if (
    services.size !== previewRoles.length ||
    !workerBaseOrigin ||
    !databaseUrl
  ) {
    throw new Error(
      "Preview services or approved database must be provisioned before deploy"
    );
  }
  await checkPrivateServices();
  const candidate = parse(
    PreviewCandidate,
    "The preview candidate is missing an approved image, deployment or database binding"
  )({
    pr: pilot.pr,
    binding: {
      commitSha: pilot.sha,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
      branchTag: previewBackendBranchTag(pilot.ref),
      databaseEndpoint: previewDatabaseEndpoint(databaseUrl),
    },
    neonBranch: pilot.neonBranch,
    image: process.env.IMAGE_REF,
    signingVersion: process.env.PREVIEW_SIGNING_SECRET_VERSION,
    workerBaseOrigin,
  });
  await checkTagCapacity();
  await checkPilotHead(pilot, "open");
  const databaseVersion =
    versionFromAppliedCandidate(services, candidate) ??
    (await addDatabaseVersion(databaseUrl));
  const target = parse(
    PreviewTarget,
    "Invalid preview database secret version"
  )({ ...candidate, databaseVersion });
  await checkPilotHead(pilot, "open");
  await applyStack("deploy", target);
  await checkPrivateServices();
  const deployed = await readSnapshot();
  for (const role of previewRoles) {
    verifyPreviewRouting(role, deployed.get(role), target);
  }
  await checkPilotHead(pilot, "open");
  process.stdout.write(
    `Preview commit ${pilot.sha} serves through ${previewRevision("api", target)} with worker tag ${previewWorkerTag(target)}\n`
  );
};

const cleanup = async (pilot: Pilot) => {
  await checkPilotHead(pilot, "closed");
  const services = await readSnapshot();
  requireOwnedServices(services, pilot.pr, pilot.neonBranch);
  if (
    previewSnapshotFence(services) !==
    previewSnapshotFence(await readSnapshot())
  ) {
    throw new Error("The preview changed before cleanup");
  }
  await checkPilotHead(pilot, "closed");
  await applyStack("destroy");
  if ((await readSnapshot()).size > 0) {
    throw new Error("Preview cleanup left Cloud Run services behind");
  }
  await purgeDatabaseVersions();
  await purgeImages();
  process.stdout.write(
    "Preview services, database secret versions and pilot images were removed\n"
  );
};

const main = async () => {
  const mode = process.argv[2];
  if (mode === "seed" && process.env.GITHUB_ACTIONS !== "true") {
    if (!canResumePreviewSeed(await readSnapshot())) {
      throw new Error(
        "Preview services contain an active generation or are changing"
      );
    }
    await applyStack("deploy");
    await checkPrivateServices();
    process.stdout.write("Preview seed services were created\n");
    return;
  }
  const pilot = parse(
    Pilot,
    "Missing approved pilot identity"
  )({
    pr: process.env.PR_NUMBER,
    ref: process.env.GIT_REF,
    sha: process.env.GIT_SHA,
    neonBranch: process.env.NEON_BRANCH_ID,
  });
  if (mode === "deploy") {
    await deploy(pilot);
  } else if (mode === "cleanup") {
    await cleanup(pilot);
  } else {
    throw new Error("Unknown backend preview command");
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Only fixed diagnostic messages reach CI logs. Provider response bodies,
    // candidate origins, connection strings, and auth values stay on the runner.
    process.stderr.write(
      `${
        error instanceof Error && error.constructor === Error
          ? error.message
          : "Backend preview operation failed"
      }\n`
    );
    process.exitCode = 1;
  }
}
