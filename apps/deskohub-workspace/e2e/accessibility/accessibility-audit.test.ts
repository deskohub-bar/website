import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supportedLocales } from "@deskohub/i18n/locale-registry";
import { auditedLocales, hasAriaSnapshots } from "./accessibility-audit";

const snapshotDirectories = [
  "checkout-pay-accessibility.pw.ts-snapshots",
  "workspace-aria-snapshots.pw.ts-snapshots",
];

test("runs axe audits for every supported locale", () => {
  expect(new Set(auditedLocales)).toEqual(new Set(supportedLocales));
});

test("each ARIA audit has snapshot files for the selected locales", async () => {
  const selectedLocales = new Set(auditedLocales.filter(hasAriaSnapshots));
  expect(selectedLocales.size).toBeGreaterThan(0);

  for (const directory of snapshotDirectories) {
    const files = await readdir(join(import.meta.dir, directory));
    const recordedLocales = new Set(
      files.map((file) =>
        auditedLocales.find((locale) => file.startsWith(`${locale}-`))
      )
    );
    expect(recordedLocales).toEqual(selectedLocales);
  }
});
