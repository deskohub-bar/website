import { Schema } from "effect";

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const SecurityRequirements = Schema.Array(
  Schema.Record(Schema.String, Schema.Array(Schema.String))
);

const ExternalDocs = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  url: Schema.String,
});

/**
 * Every operation field the generator reads. Parameters, request bodies and
 * responses may be `$ref`s the generator resolves, so they stay JSON objects.
 */
const OpenApiOperation = Schema.Struct({
  deprecated: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.String),
  externalDocs: Schema.optionalKey(ExternalDocs),
  operationId: Schema.optionalKey(Schema.String),
  parameters: Schema.optionalKey(Schema.Array(JsonObject)),
  requestBody: Schema.optionalKey(JsonObject),
  responses: Schema.optionalKey(Schema.Record(Schema.String, JsonObject)),
  security: Schema.optionalKey(SecurityRequirements),
  summary: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenApiPathItem = Schema.Struct({
  delete: Schema.optionalKey(OpenApiOperation),
  get: Schema.optionalKey(OpenApiOperation),
  head: Schema.optionalKey(OpenApiOperation),
  options: Schema.optionalKey(OpenApiOperation),
  parameters: Schema.optionalKey(Schema.Array(JsonObject)),
  patch: Schema.optionalKey(OpenApiOperation),
  post: Schema.optionalKey(OpenApiOperation),
  put: Schema.optionalKey(OpenApiOperation),
  query: Schema.optionalKey(OpenApiOperation),
  trace: Schema.optionalKey(OpenApiOperation),
  "x-oai-additionalOperations": Schema.optionalKey(
    Schema.Record(Schema.String, OpenApiOperation)
  ),
});

/**
 * A JSON document as `@effect/openapi-generator` reads it
 * (`OpenApiGenerator.OpenApiDocument`): every field it reads, optional where
 * it falls back, with each `$ref`-able parameter, request body, response and
 * component schema left as JSON for it to resolve.
 */
export const OpenApiDocument = Schema.Struct({
  components: Schema.optionalKey(
    Schema.Struct({
      schemas: Schema.optionalKey(JsonObject),
      securitySchemes: Schema.optionalKey(JsonObject),
    })
  ),
  info: Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    license: Schema.optionalKey(
      Schema.Struct({
        name: Schema.String,
        url: Schema.optionalKey(Schema.String),
      })
    ),
    summary: Schema.optionalKey(Schema.String),
    title: Schema.String,
    version: Schema.String,
  }),
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, OpenApiPathItem),
  security: Schema.optionalKey(SecurityRequirements),
  servers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        description: Schema.optionalKey(Schema.String),
        url: Schema.String,
      })
    )
  ),
  tags: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        description: Schema.optionalKey(Schema.String),
        externalDocs: Schema.optionalKey(ExternalDocs),
        name: Schema.String,
      })
    )
  ),
});

const isOpenApiDocumentShape = Schema.is(OpenApiDocument);

/**
 * Whether `document` has the `OpenApiDocument` shape. It narrows the
 * document itself instead of decoding a copy, so the fields the shape does
 * not name, such as `components.parameters` that `$ref`s point into, reach
 * the generator.
 */
export const isOpenApiDocument = (
  document: Schema.Json
): document is Schema.Json & typeof OpenApiDocument.Type =>
  isOpenApiDocumentShape(document);
