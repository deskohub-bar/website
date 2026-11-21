import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createCloudinaryCacheTags } from "./cache-tags";
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
});
