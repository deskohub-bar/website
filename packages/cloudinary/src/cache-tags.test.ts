import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createCloudinaryCacheTags, createStableHash } from "./cache-tags";
import { CloudinaryPublicIdSchema } from "./schema";

describe("createCloudinaryCacheTags", () => {
  const tags = createCloudinaryCacheTags({ namespace: "workspace" });
  const publicId = Schema.decodeSync(CloudinaryPublicIdSchema)("gallery/image");

  test("names the namespace-wide and per-image tags", () => {
    expect(tags.all()).toBe("workspace:all");
    expect(tags.image(publicId)).toBe("workspace:img:gallery/image");
    expect(tags.getTags()).toEqual(["workspace:all"]);
    expect(tags.getTags(publicId)).toEqual([
      "workspace:all",
      "workspace:img:gallery/image",
    ]);
  });

  test("gives equivalent search inputs the same tag and distinguishes different inputs", () => {
    const query = [["hero", "desk"]];
    const searchTag = tags.search(query);

    expect(tags.search()).toBe("workspace:search");
    expect(searchTag).toMatch(/^workspace:search:tags:[^:]+$/);
    expect(tags.search([["hero", "desk"]])).toBe(searchTag);
    expect(tags.search([["hero", "room"]])).not.toBe(searchTag);
    expect(tags.search([["hero"], ["desk"]])).not.toBe(searchTag);
    expect(tags.search(undefined, 12)).toBe("workspace:search:limit:12");
    expect(tags.search(query, 12)).toBe(`${searchTag}:limit:12`);
  });

  test("keeps the hashes earlier releases gave tag expressions and other values", () => {
    const cyclic: unknown[] = ["a"];
    cyclic.push(cyclic);
    const deep: unknown[] = [];
    let level = deep;
    for (let index = 0; index < 12; index += 1) {
      const next: unknown[] = [];
      level.push(next);
      level = next;
    }

    expect(
      createCloudinaryCacheTags({ namespace: "n" }).search({ tag: "gallery" })
    ).toBe("n:search:tags:2npry2");
    expect(createStableHash([["hero", "desk"]])).toBe("gkbr7v");
    expect(createStableHash(cyclic)).toBe("kai4a4");
    expect(createStableHash({ b: [1, true, null], a: { c: undefined } })).toBe(
      "i4ojs8"
    );
    expect(createStableHash("x".repeat(150))).toBe("p2uufm");
    expect(createStableHash(deep)).toBe("8uvnji");
    expect(createStableHash(12)).toBe("17l");
  });

  test("accepts any value its callers type, as earlier releases did", () => {
    interface TagFilter {
      readonly tag: string;
    }
    const filter: TagFilter = { tag: "gallery" };
    const opaque: unknown = filter;
    const cacheTags = createCloudinaryCacheTags({ namespace: "n" });

    expect(createStableHash(filter)).toBe(createStableHash(opaque));
    expect(cacheTags.search(filter)).toBe("n:search:tags:2npry2");
    expect(cacheTags.search(opaque, 12)).toBe("n:search:tags:2npry2:limit:12");
  });
});
