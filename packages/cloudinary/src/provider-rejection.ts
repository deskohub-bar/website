import { Effect, flow, Option } from "effect";
import * as Schema from "effect/Schema";

/** An optional field that reads as absent when the provider sent another type. */
const lenientField = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));

const ProviderRejectionDetailSchema = Schema.Struct({
  message: lenientField(Schema.String),
  http_code: lenientField(Schema.Finite),
});

/**
 * The fields the Cloudinary SDK puts on a rejected promise, on the value
 * itself or on its nested `error`.
 */
const ProviderRejectionSchema = Schema.Struct({
  ...ProviderRejectionDetailSchema.fields,
  error: lenientField(ProviderRejectionDetailSchema),
});

export type ProviderRejection = typeof ProviderRejectionSchema.Type;

/** Reads a rejected SDK call; values without the provider fields read as `{}`. */
export const decodeProviderRejection = flow(
  Schema.decodeUnknownOption(ProviderRejectionSchema),
  Option.getOrElse((): ProviderRejection => ({}))
);

/** The provider's numeric HTTP code, preferring the top-level one. */
export const readProviderHttpCode = (
  rejection: ProviderRejection
): number | undefined => rejection.http_code ?? rejection.error?.http_code;
