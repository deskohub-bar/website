import { Effect, Schema, Struct } from "effect";

/**
 * Response fields a newer `dhw` must still decode from an older server, which
 * omits fields it doesn't know yet. Each helper names the value an absent key
 * decodes to.
 */
export const fieldWithDefault = <S extends Schema.Top>(
  schema: S,
  value: S["Type"]
) => schema.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(value)));

/** A nullable response field; absent decodes as null. */
export const nullableField = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null))
  );

/** A list response field; absent decodes as empty. */
export const listField = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).pipe(
    Schema.withDecodingDefaultTypeKey(
      Effect.succeed<ReadonlyArray<S["Type"]>>([])
    )
  );

/**
 * A count per key of a vocabulary. Each of `addedKeys` is a key an older
 * server doesn't send yet, so its count decodes as 0 when absent; every
 * other key is required, and a map that leaves one out is refused.
 */
export const countsField = <
  const Key extends string,
  const AddedKey extends Key,
  S extends Schema.Top & { readonly Type: number },
>(
  keys: ReadonlyArray<Key>,
  addedKeys: ReadonlyArray<AddedKey>,
  count: S
) => {
  const added: ReadonlySet<string> = new Set(addedKeys);
  // The count schema decodes 0 itself, so a branded count keeps its brand.
  const defaulted = count.pipe(
    Schema.withDecodingDefaultTypeKey(Schema.decodeUnknownEffect(count)(0))
  );
  const requiredKeys = keys.filter(
    (key): key is Exclude<Key, AddedKey> => !added.has(key)
  );
  return Schema.Struct({
    ...Struct.Record(requiredKeys, count),
    ...Struct.Record(addedKeys, defaulted),
  });
};
