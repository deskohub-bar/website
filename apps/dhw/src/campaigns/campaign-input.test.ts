import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLocaleDefinition,
  supportedLocales,
} from "@deskohub/i18n/locale-registry";
import type { AudienceFilterType } from "@deskohub/workspace-admin-api";
import { Effect, Option } from "effect";
import { InvalidMutationInputError } from "../command-runtime";
import { PlatformLive } from "../platform";
import {
  type ContentChangeFlags,
  makeCampaignContentPatch,
  parseLocalizedValues,
  readAudienceFilter,
} from "./campaign-input";

test("reads and preserves completed coworking visit filters from inline JSON", async () => {
  const filter = {
    attribute: "reservationCount",
    _tag: "Condition",
    params: {
      dateBasis: "visitEnd",
      period: { _tag: "Past" },
      product: { family: "cowork", properties: [] },
    },
    operator: "eq",
    value: 1,
  } satisfies AudienceFilterType;
  const result = await Effect.runPromise(
    readAudienceFilter({
      filter: Option.some(JSON.stringify(filter)),
      filterFile: Option.none(),
    }).pipe(Effect.provide(PlatformLive))
  );
  expect(Option.getOrThrow(result)).toEqual(filter);
});

const noContentChanges = {
  subject: [],
  preheader: [],
  body: [],
  operationalReason: [],
  clearOperationalReason: [],
  removeLocale: [],
} satisfies ContentChangeFlags;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const writeBody = async (body: string) => {
  const directory = await mkdtemp(join(tmpdir(), "dhw-campaign-input-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "body.md");
  await writeFile(path, body);
  return path;
};

const contentPatch = (flags: Partial<ContentChangeFlags>) =>
  Effect.runPromise(
    makeCampaignContentPatch({ ...noContentChanges, ...flags }).pipe(
      Effect.provide(PlatformLive)
    )
  );

const contentPatchFailure = (flags: Partial<ContentChangeFlags>) =>
  Effect.runPromise(
    makeCampaignContentPatch({ ...noContentChanges, ...flags }).pipe(
      Effect.flip,
      Effect.provide(PlatformLive)
    )
  );

describe("makeCampaignContentPatch", () => {
  test("patches only the given fields and trims operational reasons", async () => {
    const bodyPath = await writeBody("# Body\n");

    const patch = Option.getOrThrow(
      await contentPatch({
        subject: ["en=Subject"],
        preheader: ["cs=Náhled"],
        body: [`en=${bodyPath}`],
        operationalReason: ["cs=  Because  "],
      })
    );

    expect(patch).toEqual({
      "en-US": { subject: "Subject", bodyMarkdown: "# Body\n" },
      "cs-CZ": { preheader: "Náhled", operationalReason: "Because" },
    });
  });

  test("removes a locale without other changes", async () => {
    expect(
      Option.getOrThrow(await contentPatch({ removeLocale: ["en-US"] }))
    ).toEqual({ "en-US": null });
  });

  test("rejects removing a locale whose reason is cleared", async () => {
    const error = await contentPatchFailure({
      clearOperationalReason: ["cs-CZ"],
      removeLocale: ["cs-CZ"],
    });

    expect(error).toBeInstanceOf(InvalidMutationInputError);
    expect(error.message).toContain("cs-CZ");
  });

  test("validates flags before reading any body file", async () => {
    const error = await contentPatchFailure({
      body: ["en=./missing-body.md"],
      removeLocale: ["en-US"],
    });

    expect(error).toBeInstanceOf(InvalidMutationInputError);
    expect(error.message).not.toContain("missing-body.md");
  });
});

describe("campaign locale names", () => {
  test("parse every short and full locale name in localized flags", async () => {
    for (const locale of supportedLocales) {
      const { language } = getLocaleDefinition(locale);
      for (const name of [language, locale]) {
        const values = await Effect.runPromise(
          parseLocalizedValues("subject", [`${name}=Hello`])
        );
        expect([...values]).toEqual([[locale, "Hello"]]);
      }
    }
  });

  test("reject a locale that isn't supported", async () => {
    const error = await Effect.runPromise(
      parseLocalizedValues("subject", ["xx=Hello"]).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidMutationInputError);
  });
});
