import { join } from "node:path";
import { Schema } from "effect";
import { readJsonFile } from "./json-file.test-utils";

const OpenRecord = Schema.Record(Schema.String, Schema.Unknown);

const BiomeConfiguration = Schema.StructWithRest(
  Schema.Struct({
    plugins: Schema.Array(Schema.String),
    overrides: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          includes: Schema.Array(Schema.String),
          plugins: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
        [OpenRecord]
      )
    ),
  }),
  [OpenRecord]
);

export const readBiomeConfig = (repositoryRoot: string) =>
  readJsonFile(
    BiomeConfiguration,
    join(repositoryRoot, "biome.json"),
    "Biome config"
  );

export const biomeFixtureConfig = (
  repositoryRoot: string,
  configuration = readBiomeConfig(repositoryRoot)
) => {
  const resolvePlugins = (plugins: readonly string[]) =>
    plugins.map((plugin) => join(repositoryRoot, plugin));

  return {
    ...configuration,
    vcs: { enabled: false },
    plugins: resolvePlugins(configuration.plugins),
    overrides: configuration.overrides.map((override) =>
      override.plugins === undefined
        ? override
        : { ...override, plugins: resolvePlugins(override.plugins) }
    ),
  };
};
