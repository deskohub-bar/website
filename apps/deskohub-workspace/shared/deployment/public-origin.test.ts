import { describe, expect, test } from "bun:test";
import {
  containerPublicOrigin,
  toPublicUrl,
  withOrigin,
} from "./public-origin";

const container = {
  WORKSPACE_RUNTIME_HOST: "container",
  WORKSPACE_PUBLIC_ORIGIN: "https://workspace-public.example",
} as const;

describe("toPublicUrl", () => {
  test("moves a container's listen-address URL onto its public origin", () => {
    for (const listenOrigin of [
      "http://0.0.0.0:3000",
      "http://127.0.0.1:3000",
      "https://0.0.0.0:8080",
    ]) {
      expect(
        toPublicUrl(
          new URL(`${listenOrigin}/en-US/faq?utm_source=synthetic#top`),
          container
        ).href
      ).toBe(
        "https://workspace-public.example/en-US/faq?utm_source=synthetic#top"
      );
    }
  });

  test("keeps the path on the public origin whatever it spells", () => {
    expect(
      toPublicUrl(new URL("http://0.0.0.0:3000//attacker.example/x"), container)
        .origin
    ).toBe("https://workspace-public.example");
  });

  test("keeps the request's origin on Vercel and in local development", () => {
    for (const settings of [
      {},
      { WORKSPACE_RUNTIME_HOST: "vercel" },
      {
        WORKSPACE_RUNTIME_HOST: "vercel",
        WORKSPACE_PUBLIC_ORIGIN: "https://workspace-public.example",
      },
      { WORKSPACE_PUBLIC_ORIGIN: "https://workspace-public.example" },
    ] as const) {
      expect(
        toPublicUrl(new URL("http://localhost:3000/en-US/faq?a=1"), settings)
          .href
      ).toBe("http://localhost:3000/en-US/faq?a=1");
    }
  });

  test("returns a copy, never the URL it was given", () => {
    const url = new URL("http://localhost:3000/en-US/faq");
    expect(toPublicUrl(url, {})).not.toBe(url);
  });
});

describe("containerPublicOrigin", () => {
  test("is the configured origin only on a container", () => {
    expect(containerPublicOrigin(container)?.origin).toBe(
      "https://workspace-public.example"
    );
    expect(
      containerPublicOrigin({
        WORKSPACE_PUBLIC_ORIGIN: "https://workspace-public.example",
      })
    ).toBeUndefined();
  });
});

describe("withOrigin", () => {
  test("keeps a path that spells another host on the given origin", () => {
    expect(
      withOrigin(
        new URL("https://workspace-alias.example//attacker.example/x?a=1"),
        new URL("https://workspace.example")
      ).href
    ).toBe("https://workspace.example//attacker.example/x?a=1");
  });
});
