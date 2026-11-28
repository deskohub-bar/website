import { afterEach, expect, test } from "bun:test";

const stageVariables = [
  "NEXT_PUBLIC_WORKSPACE_DEPLOYMENT_STAGE",
  "NEXT_PUBLIC_VERCEL_ENV",
] as const;
const stageVariablesBefore = stageVariables.map(
  (name) => [name, process.env[name]] as const
);

afterEach(() => {
  for (const [name, value] of stageVariablesBefore) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// `getClientEnv` validates once per module instance.
const browserStage = async (
  variables: Partial<Record<(typeof stageVariables)[number], string>>,
  cacheKey: string
) => {
  for (const name of stageVariables) delete process.env[name];
  Object.assign(process.env, variables);
  const { getClientEnv } = await import(`./client-env.ts?stage=${cacheKey}`);
  return getClientEnv().NEXT_PUBLIC_VERCEL_ENV;
};

test("resolves the browser's stage from the Workspace stage before Vercel's", async () => {
  expect(
    await browserStage(
      {
        NEXT_PUBLIC_WORKSPACE_DEPLOYMENT_STAGE: "production",
        NEXT_PUBLIC_VERCEL_ENV: "preview",
      },
      "workspace"
    )
  ).toBe("production");
  expect(
    await browserStage({ NEXT_PUBLIC_VERCEL_ENV: "preview" }, "vercel")
  ).toBe("preview");
  expect(await browserStage({}, "unset")).toBeUndefined();
});
