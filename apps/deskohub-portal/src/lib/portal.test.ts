import { expect, test } from "bun:test";
import { getPortalMetadata } from "./portal";

test("selects open and closed Bar descriptions in Czech", () => {
  expect(getPortalMetadata("cs-CZ", { barClosed: false }).metaDescription).toBe(
    "Deskohub portál s odkazy na Workspace a Boardgame Bar."
  );
  expect(getPortalMetadata("cs-CZ", { barClosed: true }).metaDescription).toBe(
    "Deskohub portál s odkazem na Workspace. Boardgame Bar je trvale zavřen."
  );
});

test("selects open and closed Bar descriptions in English", () => {
  expect(getPortalMetadata("en-US", { barClosed: false }).metaDescription).toBe(
    "Deskohub portal with links to Workspace and Boardgame Bar."
  );
  expect(getPortalMetadata("en-US", { barClosed: true }).metaDescription).toBe(
    "Deskohub portal linking to Workspace. Boardgame Bar is permanently closed."
  );
});
