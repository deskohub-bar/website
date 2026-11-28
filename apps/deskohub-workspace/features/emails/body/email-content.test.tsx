import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import {
  EmailDocument,
  type EmailValueSnapshot,
  WORKSPACE_SITE_TIME_ZONE,
} from "@deskohub/workspace-admin-api";
import { Result, Schema } from "effect";
import type { ReactElement } from "react";
import { render } from "react-email";
import { CampaignBodyContent } from "@/features/email-campaigns/body/campaign-body-content";
import { type Locale, m } from "@/features/i18n";
import { formatInstantDate } from "@/shared/utils/date-time-format";
import { renderEmailContent } from "./email-content";
import {
  cloudinaryImage,
  emailDocumentFixture,
  emailFixtureValues,
  emailFixtureWords,
  fixtureOfferExpiry,
  legacyRichTextBody,
  richTextParityDocument,
} from "./email-document.test-utils";

const renderHtml = (body: ReactElement) => render(body);

const rendered = (
  locale: string,
  values: Readonly<Record<string, EmailValueSnapshot>> = emailFixtureValues,
  document: EmailDocument = emailDocumentFixture
) => renderEmailContent({ document, locale, values });

const renderedContent = (...args: Parameters<typeof rendered>) =>
  Result.getOrThrow(rendered(...args));

/** The text of every element matching `tag`, in document order. */
const textsOf = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (match) =>
      (match[1] ?? "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, "")
        .replace("&#8203;", "")
  );

const failureOf = (result: ReturnType<typeof rendered>) =>
  Result.isFailure(result) ? result.failure : undefined;

describe("renderEmailContent", () => {
  test.each(["en-US", "cs-CZ"] as const)(
    "renders %s from the shared structure with its own texts and values",
    async (locale: Locale) => {
      const words = emailFixtureWords[locale];
      const content = renderedContent(locale);
      const html = await renderHtml(content.body);
      const expiry = formatInstantDate({
        instant: Temporal.Instant.from(fixtureOfferExpiry),
        locale,
        timeZone: WORKSPACE_SITE_TIME_ZONE,
      });

      expect(content.subject).toBe(`${words.subject}Jana`);
      expect(content.preheader).toBe(words.preheader);
      expect(content.operationalReason).toBeUndefined();
      expect(textsOf(html, "h1")).toEqual([words.title]);
      // The inline value keeps its bold mark; the link and italic text keep theirs.
      expect(html).toContain("<strong>Jana</strong>");
      expect(html).toMatch(
        new RegExp(
          `<em><a[^>]*href="https://deskohub.cz/akce"[^>]*>${words.events}</a></em>`
        )
      );
      expect(html).toContain(`${new Intl.NumberFormat(locale).format(1234.5)}`);
      expect(html).toContain(m.emailContentYes({}, { locale }));
      // The ordered list starts at 2 and nests a bulleted list.
      expect(html).toMatch(/<ol[^>]*start="2"/);
      expect(textsOf(html, "p")).toEqual(
        expect.arrayContaining([...words.steps])
      );
      expect(html).toMatch(/<ol[\s\S]*<ul[\s\S]*<\/ul>[\s\S]*<\/ol>/);
      // The linked image keeps its alt text, width and alignment.
      expect(html).toMatch(
        new RegExp(
          `<a[^>]*href="https://deskohub.cz/zasedacka"[^>]*><img[^>]*alt="${words.alt}"[^>]*src="${cloudinaryImage}"[^>]*width="240"`
        )
      );
      expect(html).toMatch(/<td[^>]*align="left"/);
      // Record rows label each field.
      const cells = textsOf(html, "td");
      expect(cells).toEqual(
        expect.arrayContaining([words.contactName, "Jana Testová"])
      );
      // The record list keeps the component's sort and limit.
      const groupCells = cells.filter((cell) =>
        ["Students", "Members", "Friends"].includes(cell)
      );
      expect(groupCells).toEqual(["Members", "Students"]);
      // A scalar list is a bulleted list.
      expect(textsOf(html, "li")).toEqual(
        expect.arrayContaining(["quiet corner", "coffee"])
      );
      // The offer shows its code, its localized expiry and its button.
      expect(html).toContain("SAMPLE CODE");
      expect(html).toContain(
        m.emailContentOfferValidUntil({ date: expiry }, { locale })
      );
      expect(html).toContain(m.emailContentOfferCodeLabel({}, { locale }));
      expect(textsOf(html, "a")).toEqual(
        expect.arrayContaining([words.offer, words.button])
      );
      expect(html).toContain("<hr");
    }
  );

  test("words the operational reason with its values", () => {
    const document = Schema.decodeUnknownSync(EmailDocument)({
      ...Schema.encodeSync(EmailDocument)(emailDocumentFixture),
      purpose: "operational",
      translations: {
        "en-US": {
          ...emailDocumentFixture.translations["en-US"],
          operationalReason: [
            { _tag: "Text", text: "You booked as " },
            { _tag: "Value", name: "first_name", bold: true },
            { _tag: "Text", text: ". " },
          ],
        },
      },
    });

    expect(
      renderedContent("en-US", emailFixtureValues, document)
    ).toMatchObject({ operationalReason: "You booked as Jana." });
  });

  test("prefills the Workspace cowork booking link only when the Offer opts in", async () => {
    const href =
      "https://workspace.deskohub.cz/en-US/reservation/cowork?discountCode=old&discountCode=other&date=2027-01-01#visit";
    const document = (prefillDiscountCode: boolean, destination = href) =>
      Schema.decodeUnknownSync(EmailDocument)({
        ...emailDocumentFixture,
        structure: emailDocumentFixture.structure.map((component) =>
          component._tag === "Offer"
            ? { ...component, href: destination, prefillDiscountCode }
            : component
        ),
      });
    const buttonUrls = async (prefill: boolean) => {
      const html = await renderHtml(
        renderedContent("en-US", emailFixtureValues, document(prefill)).body
      );
      return [
        ...html.matchAll(/href="(https:\/\/workspace\.deskohub\.cz\/[^"]+)"/g),
      ].map((link) => new URL(link[1]?.replaceAll("&amp;", "&") ?? ""));
    };
    const buttonUrl = async (prefill: boolean) => {
      const urls = await buttonUrls(prefill);
      // The voucher and its cue both book with the same link.
      expect(urls).toHaveLength(2);
      expect(urls[1]?.href).toBe(urls[0]?.href);
      return urls[0] ?? new URL("about:blank");
    };
    const prefilled = await buttonUrl(true);
    expect(prefilled.searchParams.getAll("discountCode")).toEqual([
      "SAMPLE CODE",
    ]);
    expect(prefilled.searchParams.get("date")).toBe("2027-01-01");
    expect(prefilled.hash).toBe("#visit");
    expect((await buttonUrl(false)).href).toBe(href);
    expect(
      Result.isFailure(
        rendered(
          "en-US",
          emailFixtureValues,
          document(true, "https://deskohub.test/reservation/cowork")
        )
      )
    ).toBe(true);
  });

  test("keeps the offer's code, validity and booking link readable as plain text", async () => {
    const locale = "en-US";
    const html = await renderHtml(renderedContent(locale).body);
    const text = await render(renderedContent(locale).body, {
      plainText: true,
    });
    const expiry = formatInstantDate({
      instant: Temporal.Instant.from(fixtureOfferExpiry),
      locale,
      timeZone: WORKSPACE_SITE_TIME_ZONE,
    });
    const validity = `${m.emailContentOfferValidUntil({ date: expiry }, { locale })} · ${m.emailContentOfferUses({ count: 1 }, { locale })}`;

    expect(text).toContain("SAMPLE CODE");
    expect(text).toContain(validity);
    expect(text).toContain(emailFixtureWords[locale].offer);
    // The arrow badge is decoration, left out of plain text.
    expect(text).not.toContain("\u2192");
    // The hand-drawn arrow is a hosted decorative image.
    expect(html).toMatch(
      /<img[^>]*alt=""[^>]*src="https:\/\/[^"]+\/email\/offer-cue-arrow\.png"/
    );
  });

  test("shows a fallback in place of the value or the whole component", async () => {
    const content = renderedContent("en-US", {
      ...emailFixtureValues,
      first_name: { _tag: "Fallback", text: "friend" },
      offer: { _tag: "Fallback", text: "Ask us about this month offer." },
    });
    const html = await renderHtml(content.body);

    expect(content.subject).toBe(`${emailFixtureWords["en-US"].subject}friend`);
    expect(html).toContain("<strong>friend</strong>");
    expect(textsOf(html, "p")).toContain("Ask us about this month offer.");
    expect(html).not.toContain("SAMPLE CODE");
    expect(html).not.toContain(
      m.emailContentOfferCodeLabel({}, { locale: "en-US" })
    );
  });

  describe("an old publication", () => {
    test("renders though today's catalogue has none of its retired fields", () => {
      // `tags`, `visits` and `member` are only in the frozen shapes.
      expect(Result.isSuccess(rendered("cs-CZ"))).toBe(true);
    });

    test("fails for a Workspace language it was never written in", () => {
      const document = Schema.decodeUnknownSync(EmailDocument)({
        ...Schema.encodeSync(EmailDocument)(emailDocumentFixture),
        translations: {
          "en-US":
            Schema.encodeSync(EmailDocument)(emailDocumentFixture).translations[
              "en-US"
            ],
        },
      });

      expect(
        Result.isSuccess(rendered("en-US", emailFixtureValues, document))
      ).toBe(true);
      expect(
        failureOf(rendered("cs-CZ", emailFixtureValues, document))
      ).toMatchObject({ _tag: "EmailLanguageMissing", locale: "cs-CZ" });
      expect(
        failureOf(rendered("de-DE", emailFixtureValues, document))
      ).toMatchObject({ _tag: "EmailLanguageMissing", locale: "de-DE" });
    });
  });

  test("renders a nullable or absent optional record field empty", async () => {
    for (const contact of [
      { displayName: "Jana Testová", email: null },
      { displayName: "Jana Testová" },
    ]) {
      const content = renderedContent("en-US", {
        ...emailFixtureValues,
        contact: { _tag: "Resolved", value: contact },
      });
      const cells = textsOf(await renderHtml(content.body), "td");

      expect(cells).toEqual(
        expect.arrayContaining([emailFixtureWords["en-US"].contactEmail, ""])
      );
    }
  });

  test("fails for a translation in a language the Workspace doesn't offer", () => {
    const encoded = Schema.encodeSync(EmailDocument)(emailDocumentFixture);
    const document = Schema.decodeUnknownSync(EmailDocument)({
      ...encoded,
      translations: {
        ...encoded.translations,
        "fr-FR": encoded.translations["en-US"],
      },
    });

    expect(
      failureOf(rendered("fr-FR", emailFixtureValues, document))
    ).toMatchObject({
      _tag: "EmailLanguageMissing",
      locale: "fr-FR",
    });
  });

  test("fails for a shown value without a snapshot", () => {
    const { contact: _contact, ...values } = emailFixtureValues;

    expect(failureOf(rendered("en-US", values))).toMatchObject({
      _tag: "EmailValueMissing",
      name: "contact",
    });
  });

  test.each([
    ["a record that isn't one", "contact", "Jana"],
    ["a record field that isn't a scalar", "contact", { displayName: [1] }],
    ["a list that isn't one", "groups", { name: "Students" }],
    ["a list item that isn't a record", "groups", ["Students"]],
    ["a scalar list item that isn't a scalar", "tags", [["coffee"]]],
    ["a sort key that isn't a scalar", "groups", [{ basisPoints: [1] }]],
    ["a scalar that is a record", "first_name", { name: "Jana" }],
    ["a scalar of another type than publication froze", "first_name", 42],
    ["a record without a required field", "contact", { email: null }],
    [
      "a record with a field publication didn't select",
      "contact",
      { displayName: "Jana", phone: "1" },
    ],
    ["a discount without a code", "offer", { expiresAt: fixtureOfferExpiry }],
    [
      "a discount with an invalid expiry",
      "offer",
      { code: "A", expiresAt: "soon" },
    ],
  ])("fails for %s", (_, name, value) => {
    expect(
      failureOf(
        rendered("en-US", {
          ...emailFixtureValues,
          [name]: { _tag: "Resolved", value },
        })
      )
    ).toMatchObject({ _tag: "EmailValueMismatch", name });
  });
});

describe("rich text parity with campaign bodies", () => {
  test("renders the same body HTML as the campaign renderer, byte for byte", async () => {
    const content = renderedContent(
      "en-US",
      {
        first_name: { _tag: "Resolved", value: "Jana" },
      },
      richTextParityDocument
    );

    expect(await renderHtml(content.body)).toBe(
      await renderHtml(
        <CampaignBodyContent
          body={{ formatVersion: 1, doc: legacyRichTextBody }}
          locale="en-US"
        />
      )
    );
  });
});

describe("trigger values, conditional blocks, and dynamic button links", () => {
  const triggerDocument = Schema.decodeUnknownSync(EmailDocument)({
    purpose: "marketing",
    templateKey: "workspace",
    values: [
      {
        name: "pass",
        source: { kind: "trigger", trigger: "unlimited-ending" },
      },
    ],
    structure: [
      {
        _tag: "Paragraph",
        id: "greeting_named",
        textKey: "greeting_named",
        when: { name: "pass", field: ["firstName"], present: true },
      },
      {
        _tag: "Paragraph",
        id: "greeting_unnamed",
        textKey: "greeting_unnamed",
        when: { name: "pass", field: ["firstName"], present: false },
      },
      {
        _tag: "Paragraph",
        id: "desk_note",
        textKey: "desk_note",
        when: { name: "pass", field: ["deskLabel"], present: true },
      },
      {
        _tag: "Button",
        id: "renew",
        labelKey: "renew_label",
        hrefValue: { name: "pass", field: ["actionUrl"] },
      },
    ],
    translations: {
      "en-US": {
        subject: [
          { _tag: "Text", text: "Ends on " },
          { _tag: "Value", name: "pass", field: ["endsOn"] },
        ],
        preheader: [{ _tag: "Value", name: "pass", field: ["tier"] }],
        texts: {
          greeting_named: [
            { _tag: "Text", text: "Hi " },
            { _tag: "Value", name: "pass", field: ["firstName"] },
            { _tag: "Text", text: "," },
          ],
          greeting_unnamed: [{ _tag: "Text", text: "Hello," }],
          desk_note: [
            { _tag: "Text", text: "Keep " },
            { _tag: "Value", name: "pass", field: ["deskLabel"], bold: true },
            { _tag: "Text", text: " starting " },
            { _tag: "Value", name: "pass", field: ["renewalStartsOn"] },
          ],
          renew_label: [{ _tag: "Text", text: "Extend membership" }],
        },
      },
    },
  });

  test("renders conditional blocks and dynamic button hrefs when optional fields are present or missing", async () => {
    const withFields = renderedContent(
      "en-US",
      {
        pass: {
          _tag: "Resolved",
          value: {
            firstName: "Jana",
            tier: "Reserved Desk",
            endsOn: "Mon 26 Oct",
            renewalStartsOn: "Tue 27 Oct",
            deskLabel: "Desk 14",
            actionUrl: "https://workspace.deskohub.cz/en-US/passes/renew",
          },
        },
      },
      triggerDocument
    );
    expect(withFields.subject).toBe("Ends on Mon 26 Oct");
    expect(withFields.preheader).toBe("Reserved Desk");
    const htmlWith = await renderHtml(withFields.body);
    expect(htmlWith).toContain("Hi Jana,");
    expect(htmlWith).not.toContain("Hello,");
    expect(htmlWith).toContain("<strong>Desk 14</strong>");
    expect(htmlWith).toContain(
      'href="https://workspace.deskohub.cz/en-US/passes/renew"'
    );

    const withoutOptional = renderedContent(
      "en-US",
      {
        pass: {
          _tag: "Resolved",
          value: {
            firstName: null,
            tier: "Open Space",
            endsOn: "Mon 26 Oct",
            renewalStartsOn: "Tue 27 Oct",
            deskLabel: null,
            actionUrl: "https://workspace.deskohub.cz/en-US/passes/renew",
          },
        },
      },
      triggerDocument
    );
    const htmlWithout = await renderHtml(withoutOptional.body);
    expect(htmlWithout).toContain("Hello,");
    expect(htmlWithout).not.toContain("Hi ");
    expect(htmlWithout).not.toContain("Keep ");
    expect(htmlWithout).toContain(
      'href="https://workspace.deskohub.cz/en-US/passes/renew"'
    );
  });

  test("rejects unsafe protocols in dynamic button href values", () => {
    expect(
      failureOf(
        rendered(
          "en-US",
          {
            pass: {
              _tag: "Resolved",
              value: {
                firstName: null,
                tier: "Open Space",
                endsOn: "Mon 26 Oct",
                renewalStartsOn: "Tue 27 Oct",
                deskLabel: null,
                actionUrl: "javascript:alert(1)",
              },
            },
          },
          triggerDocument
        )
      )
    ).toMatchObject({ _tag: "EmailValueMismatch", name: "pass" });
  });
});
