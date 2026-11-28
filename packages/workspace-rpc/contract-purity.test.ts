import { expect, test } from "bun:test";
import { isBuiltin } from "node:module";
import ts from "typescript";
import manifest from "./package.json";

const allowedDependencies = new Set([
  "effect",
  "@deskohub/i18n",
  "@deskohub/standard-schema",
  "@deskohub/workspace-admin-api",
  "@deskohub/workspace-customer-api",
]);

const forbidden =
  /^(?:node:|bun:|server-only$|(?:bun|effect-rpc-baseline|next|react|react-dom|better-auth|jose|drizzle-orm|pg|postgres)(?:\/|$)|@\/|@(?:better-auth|google-cloud|vercel)\/|@deskohub\/(?!(?:i18n\/locale-registry$|(?:standard-schema|workspace-admin-api|workspace-customer-api)(?:\/|$)))|(?:.*\/)?apps\/)/;

type DependencyMap = Readonly<Record<string, string>>;

interface PackageDependencies {
  readonly dependencies?: DependencyMap;
  readonly optionalDependencies?: DependencyMap;
  readonly peerDependencies?: DependencyMap;
  readonly devDependencies?: DependencyMap;
}

test("the RPC package declares only contract dependencies and test tooling", () => {
  const {
    dependencies,
    optionalDependencies,
    peerDependencies,
    devDependencies,
  }: PackageDependencies = manifest;

  const runtimeDependencies = Object.keys({
    ...dependencies,
    ...optionalDependencies,
    ...peerDependencies,
  });
  const testDependencies = new Set(["effect-rpc-baseline", "typescript"]);
  expect(
    runtimeDependencies.filter((name) => !allowedDependencies.has(name))
  ).toEqual([]);
  expect(
    Object.keys(devDependencies ?? {}).filter(
      (name) => !(allowedDependencies.has(name) || testDependencies.has(name))
    )
  ).toEqual([]);
});

test("all RPC source modules avoid server and provider imports", async () => {
  const source = new URL("./src/", import.meta.url);
  const offenders: string[] = [];
  for await (const path of new Bun.Glob(
    "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"
  ).scan(source.pathname)) {
    const content = await Bun.file(new URL(path, source)).text();
    for (const { fileName } of ts.preProcessFile(content, true, true)
      .importedFiles) {
      if (fileName === "bun:test" && path.endsWith(".test.ts")) continue;
      if (isBuiltin(fileName) || forbidden.test(fileName)) {
        offenders.push(`${path} imports ${fileName}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("the RPC and testing exports bundle without server or provider modules", async () => {
  const bundled = await Bun.build({
    entrypoints: Object.values(manifest.exports).map(
      (path) => new URL(path, import.meta.url).pathname
    ),
    target: "browser",
    plugins: [
      {
        name: "workspace-rpc-contract",
        setup(build) {
          build.onResolve({ filter: forbidden }, (args) => {
            throw new Error(
              `Import ${args.path} reached from ${args.importer}`
            );
          });
        },
      },
    ],
  });

  expect(bundled.success).toBe(true);
});
