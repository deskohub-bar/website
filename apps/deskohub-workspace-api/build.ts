import { argv } from "node:process";

const target = argv[2];
if (target !== "main" && target !== "sandbox") {
  throw new Error("Select the main or sandbox Workspace API entrypoint.");
}

await Bun.build({
  entrypoints: [`./src/${target}.ts`],
  outdir: "./dist",
  naming: { entry: target === "main" ? "workspace-api.mjs" : "sandbox.mjs" },
  target: "node",
  format: "esm",
  plugins: [
    {
      name: "standalone-workspace-api",
      setup(build) {
        build.onResolve({ filter: /^(next|server-only)(\/|$)/ }, ({ path }) => {
          throw new Error(`The Workspace API cannot import ${path}.`);
        });
      },
    },
  ],
});
