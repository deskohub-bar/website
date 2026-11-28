import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { locales, m } from "@/features/i18n";

const loadCatalog = (locale: (typeof locales)[number]) =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    JSON.parse(
      readFileSync(
        new URL(`./messages/${locale}.json`, import.meta.url),
        "utf8"
      )
    )
  );

const source = loadCatalog("cs-CZ");
const isText = Schema.is(Schema.String);
const relevant =
  /^(?:reservation(?:ValidationTable|Table|AccessTeamTable|AssignedTableLabel|OpenSpace(?:Description|BulletDesk|Etiquette))|checkoutStatusTableInvitee|tableInvit|invoiceTable|pricingTeamTable|landingOffering(?:OpenSpaceText|TeamTable)|coworkingOpenSpaceText|faqAnswerDesks)/;
const describePlaceholders = (message: string) =>
  (message.match(/\{\w+\}|<\/?\w+>/g) ?? []).sort();
const titles = {
  "cs-CZ": "Týmový stůl",
  "de-DE": "Teamtisch",
  "en-US": "Team Table",
  "hi-IN": "टीम टेबल",
  "sk-SK": "Tímový stôl",
  "uk-UA": "Командний стіл",
  "vi-VN": "Bàn nhóm",
} satisfies Record<(typeof locales)[number], string>;
const assignedTableLabels = {
  "cs-CZ": "Rezervovaný stůl",
  "de-DE": "Reservierter Tisch",
  "en-US": "Reserved table",
  "hi-IN": "बुक की गई टेबल",
  "sk-SK": "Rezervovaný stôl",
  "uk-UA": "Заброньований стіл",
  "vi-VN": "Bàn đã đặt",
} satisfies Record<(typeof locales)[number], string>;

for (const locale of locales) {
  test(`${locale} keeps the ordered customer catalog, Team Table copy and placeholders`, () => {
    const translated = loadCatalog(locale);
    expect(Object.keys(translated)).toEqual(Object.keys(source));
    expect(m.reservationTableProductTitle({}, { locale })).toBe(titles[locale]);
    expect(m.reservationAssignedTableLabel({}, { locale })).toBe(
      assignedTableLabels[locale]
    );
    for (const [key, sourceMessage] of Object.entries(source)) {
      if (!relevant.test(key) || !isText(sourceMessage)) continue;
      const translatedMessage = translated[key];
      if (!isText(translatedMessage))
        throw new Error(`Missing text for ${key}`);
      expect(translatedMessage.trim().length).toBeGreaterThan(0);
      expect(describePlaceholders(translatedMessage)).toEqual(
        describePlaceholders(sourceMessage)
      );
    }
  });
}
