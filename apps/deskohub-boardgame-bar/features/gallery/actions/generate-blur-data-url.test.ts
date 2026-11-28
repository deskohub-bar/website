import {
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { CloudinaryAsset } from "@deskohub/cloudinary";
import { setBoardgameTestEnv } from "@/shared/testing/boardgame-test-env";
import { cloudinaryTags } from "@/shared/utils/cache-tags";

const appliedTags: string[] = [];

let generateBlurDataUrlCached: typeof import("./generate-blur-data-url").generateBlurDataUrlCached;

beforeAll(async () => {
  setBoardgameTestEnv();
  const nextCache = await import("next/cache");
  mock.module("next/cache", () => ({
    ...nextCache,
    cacheTag: (...tags: string[]) => {
      appliedTags.push(...tags);
    },
  }));
  ({ generateBlurDataUrlCached } = await import("./generate-blur-data-url"));
});

const asset = { public_id: "bar/tables/window" } as CloudinaryAsset;

let restoreFetch: (() => void) | undefined;

const respondWith = (response: Response) => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
  restoreFetch = () => fetchSpy.mockRestore();
};

afterEach(() => {
  restoreFetch?.();
  appliedTags.length = 0;
});

describe("generateBlurDataUrlCached", () => {
  test("tags the blur placeholder cache entry for the source image", async () => {
    respondWith(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      })
    );

    expect(await generateBlurDataUrlCached(asset)).toBe(
      "data:image/png;base64,AQID"
    );
    expect(appliedTags).toEqual(cloudinaryTags.getTags(asset.public_id));
  });

  test("rejects when the provider cannot load the rendition", async () => {
    respondWith(new Response(null, { status: 404, statusText: "Not Found" }));

    await expect(generateBlurDataUrlCached(asset)).rejects.toThrow("Not Found");
  });
});
