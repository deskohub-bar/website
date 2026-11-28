import { Predicate } from "effect";
import type { CloudinaryPublicId } from "./schema";

const maxPrimitiveLength = 100;
const maxEntries = 50;
const maxDepth = 10;
const maxSerializedLength = 1000;

/** `String(value)`, which spells `null` and `undefined` out, cut to 100 characters. */
const stringifyPrimitive = <Value>(value: Value) => {
  const stringValue = String(value);
  return stringValue.length > maxPrimitiveLength
    ? `${stringValue.substring(0, maxPrimitiveLength)}...`
    : stringValue;
};

/**
 * A short hash that is equal for structurally equal values. Arrays and plain
 * objects are walked, cycles included; anything else hashes by `String`.
 */
export function createStableHash<Value>(value: Value): string {
  const seen = new WeakSet<object>();

  const stringify = <Nested>(nestedValue: Nested, depth = 0): string => {
    if (depth > maxDepth) {
      return "[...]";
    }

    if (!Predicate.isObjectOrArray(nestedValue)) {
      return stringifyPrimitive(nestedValue);
    }

    if (seen.has(nestedValue)) {
      return "[circular]";
    }
    seen.add(nestedValue);

    if (Array.isArray(nestedValue)) {
      const items = nestedValue
        .slice(0, maxEntries)
        .map((item) => stringify(item, depth + 1));
      seen.delete(nestedValue);
      return `[${items.join(",")}${nestedValue.length > maxEntries ? ",..." : ""}]`;
    }

    const pairs = Object.keys(nestedValue)
      .sort()
      .slice(0, maxEntries)
      .map((key) => `${key}:${stringify(nestedValue[key], depth + 1)}`);
    seen.delete(nestedValue);

    return `{${pairs.join(",")}}`;
  };

  const serialized = stringify(value).substring(0, maxSerializedLength);

  let hash = 0;
  for (let index = 0; index < serialized.length; index++) {
    hash = ((hash << 5) - hash + serialized.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

export function createCloudinaryCacheTags({
  namespace,
}: {
  namespace: string;
}) {
  return {
    all: () => `${namespace}:all`,
    image: (publicId: CloudinaryPublicId) => `${namespace}:img:${publicId}`,
    search: <Tags>(tags?: Tags, maxResults?: number) => {
      const parts = [`${namespace}:search`];

      if (tags) {
        parts.push(`tags:${createStableHash(tags)}`);
      }

      if (maxResults) {
        parts.push(`limit:${maxResults}`);
      }

      return parts.join(":");
    },
    getTags: (publicId?: CloudinaryPublicId) => {
      const tags = [`${namespace}:all`];

      if (publicId) {
        tags.push(`${namespace}:img:${publicId}`);
      }

      return tags;
    },
  };
}
