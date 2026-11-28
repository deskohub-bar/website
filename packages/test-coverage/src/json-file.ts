import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";

/**
 * Reads a JSON file and decodes it with `schema`, throwing an error that names
 * the file and the decoding issue when its content doesn't match.
 */
export function readJsonFile<S extends Schema.Decoder<unknown>>(
  schema: S,
  path: string,
  description: string
): S["Type"] {
  return decodeJson(
    schema,
    readFileSync(path, "utf8"),
    `${description} ${path}`
  );
}

/** Decodes JSON text with `schema`, naming `source` when it doesn't match. */
export function decodeJson<S extends Schema.Decoder<unknown>>(
  schema: S,
  text: string,
  source: string
): S["Type"] {
  const decoded = Schema.decodeResult(Schema.fromJsonString(schema))(text);
  if (Result.isFailure(decoded)) {
    throw new Error(`Malformed ${source}: ${decoded.failure.message}`);
  }
  return decoded.success;
}
