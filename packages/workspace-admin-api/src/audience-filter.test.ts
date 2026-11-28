import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  audienceAttributeCatalogue,
  makeAudienceFilterSchemas,
} from "./audience-filter";

const VisitCount = Schema.TaggedStruct("VisitCount", {
  count: Schema.NumberFromString,
});

describe("makeAudienceFilterSchemas", () => {
  test("a filter keeps an extra leaf's encoding", () => {
    const { filter } = makeAudienceFilterSchemas(audienceAttributeCatalogue, {
      extraLeaves: [VisitCount],
    });
    const encoded = {
      _tag: "Group",
      operator: "and",
      filters: [{ _tag: "VisitCount", count: "41" }],
    } as const;
    const decoded = Schema.decodeUnknownSync(filter)(encoded);

    expect(decoded).toEqual({
      _tag: "Group",
      operator: "and",
      filters: [{ _tag: "VisitCount", count: 41 }],
    });
    expect(Schema.encodeSync(filter)(decoded)).toEqual(encoded);
  });
});
