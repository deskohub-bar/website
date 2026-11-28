import { Schema } from "effect";

/**
 * A value `JSON.parse` returns. Unlike `Schema.Json`, it accepts the
 * non-finite numbers that an out-of-range literal such as `1e400` parses to,
 * so a parsed request body passes as it arrived.
 */
const parsedJsonSchema: Schema.Codec<Schema.Json> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number,
  Schema.String,
  Schema.Array(Schema.suspend(() => parsedJsonSchema)),
  Schema.Record(
    Schema.String,
    Schema.suspend(() => parsedJsonSchema)
  ),
]);

/** Whether a value is one `JSON.parse` could return. */
export const isParsedJson = Schema.is(parsedJsonSchema);
