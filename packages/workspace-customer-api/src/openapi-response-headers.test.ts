import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/http-api";
import { responseHeaders } from "./openapi-response-headers";

const apiWith = (endpoint: HttpApiEndpoint.Constraint) =>
  HttpApi.make("test").add(HttpApiGroup.make("files").add(endpoint));

describe("responseHeaders", () => {
  test("describes a custom response header", () => {
    const spec = OpenApi.fromApi(
      apiWith(
        HttpApiEndpoint.get("download", "/download", {
          success: Schema.String,
        }).annotateMerge(
          responseHeaders(200, { "X-File-Name": { description: "The name." } })
        )
      )
    );

    expect(spec.paths["/download"]?.get?.responses?.[200]).toMatchObject({
      headers: {
        "X-File-Name": {
          description: "The name.",
          required: true,
          schema: { type: "string" },
        },
      },
    });
  });

  test("refuses a status the endpoint doesn't answer", () => {
    expect(() =>
      OpenApi.fromApi(
        apiWith(
          HttpApiEndpoint.get("download", "/download", {
            success: Schema.String,
          }).annotateMerge(
            responseHeaders(201, {
              "X-File-Name": { description: "The name." },
            })
          )
        )
      )
    ).toThrow("files.download has no 201 response to describe headers on");
  });
});
