import { describe, expect, test } from "bun:test";
import { type AddressedRequest, addressedOrigin } from "./addressed-origin";

// A container's server sees its own listen address in the request URL.
const listenUrl = new URL("https://0.0.0.0:8080/en-US/faq");

const addressedRequest = (
  url: URL,
  headers: Record<string, string>
): AddressedRequest => ({ headers: new Headers(headers), nextUrl: url });

describe("addressedOrigin", () => {
  test("keeps the request URL on Vercel, whatever Host says", () => {
    const request = addressedRequest(
      new URL("https://workspace-alias.vercel.app/en-US"),
      { host: "workspace.example" }
    );

    for (const runtimeHost of ["vercel", undefined] as const) {
      expect(addressedOrigin(request, runtimeHost)).toMatchObject({
        host: "workspace-alias.vercel.app",
        origin: "https://workspace-alias.vercel.app",
      });
    }
  });

  test("takes a container request's host from Host and its scheme from the request URL", () => {
    expect(
      addressedOrigin(
        addressedRequest(listenUrl, { host: "workspace.example" }),
        "container"
      )
    ).toMatchObject({
      host: "workspace.example",
      origin: "https://workspace.example",
    });
    expect(
      addressedOrigin(
        addressedRequest(new URL("http://0.0.0.0:8080/en-US"), {
          host: "workspace.example",
        }),
        "container"
      ).origin
    ).toBe("http://workspace.example");
  });

  test("ignores a client's X-Forwarded-Host in a container", () => {
    expect(
      addressedOrigin(
        addressedRequest(listenUrl, {
          host: "workspace-service.run.example",
          "x-forwarded-host": "workspace.example",
        }),
        "container"
      ).host
    ).toBe("workspace-service.run.example");
  });

  test("falls back to the request URL without a usable Host in a container", () => {
    const headerSets: Record<string, string>[] = [{}, { host: "[" }];
    for (const headers of headerSets) {
      expect(
        addressedOrigin(addressedRequest(listenUrl, headers), "container")
          .origin
      ).toBe("https://0.0.0.0:8080");
    }
  });
});
