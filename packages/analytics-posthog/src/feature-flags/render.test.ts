import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, type Schema } from "effect";
import {
  decodePostHogFeatureFlagPayload,
  type PostHogFeatureFlagContract,
  type PostHogFeatureFlagSnapshot,
} from "./contract";
import type { PostHogFeatureFlagDefinition } from "./definitions";
import {
  renderPostHogFeatureFlagContract,
  renderPostHogFeatureFlagSnapshot,
} from "./render";

const definitions: readonly PostHogFeatureFlagDefinition[] = [
  { key: "meeting_room_page", payloads: {}, variants: [] },
  {
    key: "room_experience",
    payloads: {
      control: '{"capacity":8,"features":["screen",true]}',
      fallback: "not-json",
    },
    variants: ["control", "treatment"],
  },
];

interface RenderedFlags {
  readonly __proto__: {
    readonly payload: { readonly __proto__: number } | undefined;
    readonly value: false | "control";
  };
  readonly overlapping: {
    readonly payload:
      | { readonly Z: number }
      | { readonly a: number; readonly Z: number }
      | undefined;
    readonly value: false | "narrow" | "wide";
  };
}

describe("renderPostHogFeatureFlagContract", () => {
  test("renders sorted keys, variants, and structural payload types", async () => {
    const contract = await Effect.runPromise(
      renderPostHogFeatureFlagContract([...definitions].reverse())
    );

    expect(contract.indexOf('  "meeting_room_page": {')).toBeLessThan(
      contract.indexOf('  "room_experience": {')
    );
    expect(contract).toContain(
      'value: Schema.Literals([false, "control", "treatment"]),'
    );
    expect(contract).toContain(
      'payload: Schema.Union([Schema.String, Schema.Undefined, Schema.Struct({ "capacity": Schema.Number, "features": Schema.Array(Schema.Union([Schema.Boolean, Schema.String])) })]),'
    );
    expect(contract).toContain(
      'readonly value: false | "control" | "treatment";'
    );
    expect(contract).toContain('readonly "capacity": number;');
    expect(contract).toContain(
      'readonly "features": readonly (boolean | string)[];'
    );
    expect(contract).toContain("readonly payload: string | undefined | {");
  });

  test("renders empty, nested, null and too-deep payload structures", async () => {
    const tooDeep = '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}';
    const contract = await Effect.runPromise(
      renderPostHogFeatureFlagContract([
        {
          key: "shapes",
          payloads: {
            empty: '{"list":[],"settings":{}}',
            nested: '{"rooms":[{"open":null,"seats":2}]}',
          },
          variants: ["empty", "nested"],
        },
        { key: "too_deep", payloads: { deep: tooDeep }, variants: ["deep"] },
        { key: "unparsed", payloads: { raw: [1, "two"] }, variants: ["raw"] },
      ])
    );

    expect(contract).toContain(
      'readonly payload: undefined | { readonly "list": readonly (unknown)[]; readonly "settings": Readonly<Record<string, never>>; } | { readonly "rooms": readonly ({ readonly "open": null; readonly "seats": number; })[]; };'
    );
    expect(contract).toContain(
      'readonly payload: undefined | { readonly "a": { readonly "b": { readonly "c": { readonly "d": { readonly "e": { readonly "f": { readonly "g": unknown; }; }; }; }; }; }; };'
    );
    expect(contract).toContain(
      "readonly payload: readonly (number | string)[] | undefined;"
    );
    expect(contract).toContain(
      'payload: Schema.Union([Schema.Undefined, Schema.Struct({ "list": Schema.Array(Schema.Unknown), "settings": Schema.Record(Schema.String, Schema.Never) }), Schema.Struct({ "rooms": Schema.Array(Schema.Struct({ "open": Schema.Null, "seats": Schema.Number })) })]),'
    );
  });

  test("never copies configured payload values into generated source", async () => {
    const contract = await Effect.runPromise(
      renderPostHogFeatureFlagContract([
        {
          key: "private_payload",
          payloads: { control: '{"apiKey":"do-not-commit-this-value"}' },
          variants: ["control"],
        },
      ])
    );

    expect(contract).toContain('readonly "apiKey": string;');
    expect(contract).not.toContain("do-not-commit-this-value");
  });

  test("renders decoders that keep own __proto__ keys and every declared field", async () => {
    const directory = mkdtempSync(join(import.meta.dir, ".tmp-render-test-"));
    try {
      const contractFile = join(directory, "contract.ts");
      await Bun.write(
        contractFile,
        await Effect.runPromise(
          renderPostHogFeatureFlagContract([
            {
              key: "__proto__",
              payloads: { control: '{"__proto__":1}' },
              variants: ["control"],
            },
            {
              key: "overlapping",
              payloads: { narrow: '{"Z":1}', wide: '{"a":1,"Z":2}' },
              variants: ["narrow", "wide"],
            },
          ])
        )
      );
      const postHogFeatureFlags: PostHogFeatureFlagContract<RenderedFlags> = (
        await import(contractFile)
      ).postHogFeatureFlags;
      const payloadOf = (
        key: keyof RenderedFlags,
        payload: Schema.Json
      ): Schema.Json | undefined =>
        decodePostHogFeatureFlagPayload(postHogFeatureFlags, key)(payload);

      expect(postHogFeatureFlags.keys).toEqual(["__proto__", "overlapping"]);
      expect(payloadOf("__proto__", JSON.parse('{"__proto__":1}'))).toEqual(
        JSON.parse('{"__proto__":1}')
      );
      expect(payloadOf("__proto__", {})).toBeUndefined();
      expect(payloadOf("overlapping", { a: 1, Z: 2 })).toEqual({ a: 1, Z: 2 });
      expect(payloadOf("overlapping", { Z: 1 })).toEqual({ Z: 1 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("uses unknown for redacted payloads", async () => {
    const contract = await Effect.runPromise(
      renderPostHogFeatureFlagContract([
        {
          key: "redacted_payload",
          payloads: { control: "[REDACTED]" },
          variants: ["control"],
        },
      ])
    );

    expect(contract).toContain("readonly payload: unknown;");
  });

  test("renders TypeScript literals without HTML escaping", async () => {
    const contract = await Effect.runPromise(
      renderPostHogFeatureFlagContract([
        {
          key: "room<&",
          payloads: {},
          variants: ["control<&"],
        },
      ])
    );

    expect(contract).toContain('readonly "room<&": {');
    expect(contract).toContain('readonly value: false | "control<&";');
    expect(contract).not.toContain("&lt;");
    expect(contract).not.toContain("&amp;");
  });
});

describe("renderPostHogFeatureFlagSnapshot", () => {
  test("records each key's constant value and the read instant", async () => {
    const generatedAt = new Date("2026-11-09T12:34:56.789Z");
    const source = await Effect.runPromise(
      renderPostHogFeatureFlagSnapshot({
        definitions: [
          {
            constantEnabledValue: true,
            key: "released",
            payloads: {},
            variants: [],
          },
          {
            constantEnabledValue: false,
            key: "withheld",
            payloads: {},
            variants: [],
          },
          { key: "targeted", payloads: {}, variants: [] },
          {
            constantEnabledValue: true,
            key: "outside_contract",
            payloads: {},
            variants: [],
          },
        ],
        generatedAt,
        keys: ["withheld", "targeted", "released", "deleted_in_posthog"],
      })
    );

    const snapshot = await importSnapshot(source);

    expect(snapshot).toEqual({
      generatedAt: generatedAt.toISOString(),
      constantValues: {
        deleted_in_posthog: null,
        released: true,
        targeted: null,
        withheld: false,
      },
    });
  });
});

const importSnapshot = async (
  source: string
): Promise<PostHogFeatureFlagSnapshot> => {
  const directory = mkdtempSync(join(tmpdir(), "posthog-flag-snapshot-"));
  try {
    const path = join(directory, "flag-snapshot.ts");
    await Bun.write(path, source);
    const module: { postHogFeatureFlagSnapshot: PostHogFeatureFlagSnapshot } =
      await import(path);
    return module.postHogFeatureFlagSnapshot;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};
