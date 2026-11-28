import { describe, expect, test } from "bun:test";
import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator";
import { Effect, type Schema } from "effect";
import { isOpenApiDocument } from "./openapi-document";

const document = {
  openapi: "3.1.0",
  info: { title: "PostHog", version: "1.0.0" },
  paths: {
    "/flags": {
      get: {
        parameters: [{ name: "limit", in: "query" }],
        responses: { "200": { description: "OK" } },
      },
    },
  },
  components: { schemas: { Flag: { type: "object" } } },
};

describe("isOpenApiDocument", () => {
  test("accepts a document the generator can walk", () => {
    expect(isOpenApiDocument(document)).toBeTrue();
  });

  test.each<readonly [string, Schema.Json]>([
    ["a path item that is not an object", { "/flags": null }],
    ["an operation that is not an object", { "/flags": { get: "list" } }],
    [
      "parameters that are not objects",
      { "/flags": { get: { parameters: [null] } } },
    ],
    [
      "a response that is not an object",
      { "/flags": { get: { responses: { "200": 1 } } } },
    ],
    ["operation tags that are not strings", { "/flags": { get: { tags: 1 } } }],
    [
      "operation security that is not a requirement list",
      { "/flags": { get: { security: [1] } } },
    ],
  ])("rejects %s", (_case, paths) => {
    expect(isOpenApiDocument({ ...document, paths })).toBeFalse();
  });

  test("rejects a document without info", () => {
    expect(
      isOpenApiDocument({ openapi: "3.1.0", paths: document.paths })
    ).toBeFalse();
  });

  test("hands the generator a document whose references it resolves", async () => {
    const source: Schema.Json = {
      openapi: "3.1.0",
      info: { title: "Flags", version: "1.0.0" },
      paths: {
        "/flags": {
          get: {
            operationId: "listFlags",
            tags: ["flags"],
            parameters: [{ $ref: "#/components/parameters/Limit" }],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Flag" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        parameters: {
          Limit: {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer" },
          },
        },
        schemas: {
          Flag: {
            type: "object",
            required: ["key"],
            properties: { key: { type: "string" } },
          },
        },
      },
    };
    if (!isOpenApiDocument(source)) {
      throw new Error("The fixture is not an OpenAPI document.");
    }

    const client = await Effect.runPromise(
      Effect.gen(function* () {
        const generator = yield* OpenApiGenerator.OpenApiGenerator;
        return yield* generator.generate(source, {
          format: "httpclient",
          name: "FlagsClient",
        });
      }).pipe(Effect.provide(OpenApiGenerator.layerTransformerSchema))
    );

    expect(client).toContain("listFlags");
    expect(client).toContain("limit");
  });
});
