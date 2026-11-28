import { describe, expect, test } from "bun:test";
import {
  getLocaleDefinition,
  supportedLocales,
} from "@deskohub/i18n/locale-registry";
import { testEmailAddress } from "@deskohub/test-email";
import { Result, Schema } from "effect";
import {
  EmailDocumentForPublication,
  type EmailDocumentProblem,
  emailDocumentRequiredTriggers,
  emailDocumentUsesDiscounts,
  emailDraftProblems,
  emailPublicationProblems,
  englishEmailDocumentProblem,
  referencedEmailValueNames,
  requiredEmailLocale,
  requiredEmailValueNames,
} from "./email-publication";
import { EmailDocument, EmailDraft, type EmailInlinePart } from "./emails";

const publish = Schema.decodeUnknownResult(EmailDocumentForPublication);
const draft = Schema.decodeUnknownSync(EmailDraft);
const tags = (problems: readonly EmailDocumentProblem[]) =>
  problems.map((problem) => problem._tag);

const discountId = "01900000-0000-7000-8000-000000000001";
const texts = (word: string) => {
  const intro: Array<typeof EmailInlinePart.Encoded> = [
    { _tag: "Text", text: `${word} `, bold: true },
    { _tag: "Text", text: "book", italic: true, link: "book" },
    { _tag: "Text", text: ", " },
    { _tag: "Value", name: "first_name", bold: true },
  ];
  return {
    heading: [{ _tag: "Text", text: `${word} heading` }],
    intro,
    item_one: [{ _tag: "Text", text: `${word} one` }],
    item_nested: [{ _tag: "Value", name: "offer", field: ["code"] }],
    image_alt: [],
    offer_label: [{ _tag: "Text", text: `${word} redeem` }],
  };
};

/** One shared structure with every component kind and both languages. */
const firstName = {
  name: "first_name",
  source: {
    kind: "customer",
    path: ["profile", "customer", "displayName"],
  },
  fallback: { "cs-CZ": "zákazníku", "en-US": "there" },
};

const richDocument = {
  purpose: "marketing",
  templateKey: "workspace",
  structure: [
    { _tag: "Heading", id: "heading", textKey: "heading", level: 1 },
    {
      _tag: "Paragraph",
      id: "intro",
      textKey: "intro",
      links: { book: "https://workspace.deskohub.test/book" },
    },
    { _tag: "Spacer", id: "space" },
    {
      _tag: "TextList",
      id: "list",
      ordered: false,
      items: [
        {
          textKey: "item_one",
          list: {
            ordered: true,
            start: 3,
            items: [{ textKey: "item_nested" }],
          },
        },
      ],
    },
    { _tag: "Divider", id: "rule" },
    {
      _tag: "Image",
      id: "image",
      src: "https://res.cloudinary.com/cloud/image/upload/v1/email-campaigns/preview/a.png",
      altKey: "image_alt",
      align: "left",
      width: 320,
      href: `mailto:${testEmailAddress("hello")}`,
    },
    {
      _tag: "Offer",
      id: "offer",
      value: "offer",
      labelKey: "offer_label",
      href: "https://workspace.deskohub.test/",
    },
  ],
  translations: {
    "cs-CZ": {
      subject: [
        { _tag: "Text", text: "Ahoj " },
        { _tag: "Value", name: "first_name" },
      ],
      preheader: [],
      texts: texts("cs"),
    },
    "en-US": {
      subject: [{ _tag: "Text", text: "Hello" }],
      preheader: [],
      texts: texts("en"),
    },
  },
  values: [
    {
      name: "offer",
      source: { kind: "discount", discountId, validDays: 30 },
    },
    firstName,
  ],
};

describe("rich multilingual structure", () => {
  test("publishes shared formatting, lists, dividers, spacers, image layout and offers", () => {
    expect(emailDraftProblems(draft(richDocument))).toEqual([]);
    const published = publish(richDocument);
    expect(Result.isSuccess(published)).toBe(true);
    const document = Result.getOrThrow(published);
    expect(document.structure.map((component) => component._tag)).toEqual([
      "Heading",
      "Paragraph",
      "Spacer",
      "TextList",
      "Divider",
      "Image",
      "Offer",
    ]);
    // Nested list texts reference values like any other text.
    expect<ReadonlyArray<string>>(requiredEmailValueNames(document)).toEqual([
      "offer",
      "first_name",
    ]);
  });

  test("historical documents without the new fields decode unchanged", () => {
    const historical = {
      purpose: "operational",
      templateKey: "workspace",
      structure: [
        { _tag: "Paragraph", id: "body", textKey: "body" },
        {
          _tag: "Image",
          id: "photo",
          src: "http://images.deskohub.test/a.png",
          altKey: "alt",
        },
        {
          _tag: "Button",
          id: "cta",
          labelKey: "cta",
          href: "http://workspace.deskohub.test/",
        },
      ],
      translations: {
        "cs-CZ": {
          subject: [{ _tag: "Text", text: "Ahoj" }],
          preheader: [],
          texts: { body: [{ _tag: "Text", text: "Text" }] },
        },
      },
      values: [],
    };
    // Today's publication rules, such as https-only destinations, never
    // apply to stored versions.
    expect<unknown>(
      Schema.decodeUnknownSync(EmailDocument)(historical)
    ).toEqual(historical);
    expect(Result.isFailure(publish(historical))).toBe(true);
  });

  test("plain texts refuse formatting, and links name the component's shared destinations", () => {
    const formatted = structuredClone(richDocument);
    const boldSubject = { _tag: "Text", text: "Hello", bold: true };
    const linkedLabel = { _tag: "Text", text: "Uplatnit", link: "book" };
    formatted.translations["en-US"].subject = [boldSubject];
    formatted.translations["cs-CZ"].texts.offer_label = [linkedLabel];
    formatted.translations["en-US"].texts.intro = [
      { _tag: "Text", text: "elsewhere", link: "missing" },
    ];
    const problems = emailDraftProblems(draft(formatted));
    expect<unknown>(problems).toEqual([
      {
        _tag: "FormattingNotAllowed",
        at: {
          locale: "cs-CZ",
          field: "text",
          componentId: "offer",
          textKey: "offer_label",
        },
      },
      {
        _tag: "FormattingNotAllowed",
        at: { locale: "en-US", field: "subject" },
      },
      {
        _tag: "LinkUnknown",
        link: "missing",
        at: {
          locale: "en-US",
          field: "text",
          componentId: "intro",
          textKey: "intro",
        },
      },
    ]);
    expect(Result.isFailure(publish(formatted))).toBe(true);
  });

  test("destinations must use https or mailto at publication", () => {
    const insecure = structuredClone(richDocument);
    const intro = insecure.structure[1];
    const offer = insecure.structure[6];
    if (intro?.links === undefined || offer === undefined) {
      throw new Error("The rich document lost its intro or offer.");
    }
    intro.links.book = "http://workspace.deskohub.test/book";
    offer.href = "ftp://deskohub.test/";
    expect(tags(emailDraftProblems(draft(insecure)))).toEqual([
      "DestinationInvalid",
      "DestinationInvalid",
    ]);
    expect(Result.isFailure(publish(insecure))).toBe(true);
  });

  test.each([
    [
      "https://workspace.deskohub.cz/cs-CZ/reservation/cowork?discountCode=old",
      true,
    ],
    ["https://workspace.deskohub.cz/reservation/cowork", true],
    ["https://workspace.deskohub.cz.evil.test/reservation/cowork", false],
    ["https://workspace.deskohub.cz/reservation/meeting-room", false],
  ])(
    "validates the destination of an Offer with code prefill (%s)",
    (href, valid) => {
      const document = {
        ...richDocument,
        structure: richDocument.structure.map((component) =>
          component._tag === "Offer"
            ? { ...component, href, prefillDiscountCode: true }
            : component
        ),
      };
      const result = publish(document);
      expect(Result.isSuccess(result)).toBe(valid);
      if (Result.isSuccess(result)) {
        expect(result.success.structure).toContainEqual(
          expect.objectContaining({ href, prefillDiscountCode: true })
        );
      }
    }
  );
});

describe("drafts and publication", () => {
  const broken = {
    purpose: "marketing",
    templateKey: "workspace",
    structure: [
      { _tag: "Paragraph", id: "intro", textKey: "intro" },
      { _tag: "Button", id: "cta", labelKey: "cta" },
      { _tag: "Record", id: "contact", value: "removed" },
    ],
    translations: {
      "cs-CZ": {
        subject: [
          { _tag: "Text", text: "Ahoj " },
          { _tag: "Value", name: "removed" },
        ],
        texts: {
          intro: [{ _tag: "Value", name: "first_name" }],
          cta: [{ _tag: "Text", text: "Rezervovat" }],
        },
      },
      "en-US": { subject: [{ _tag: "Text", text: "Hello" }], texts: {} },
    },
    values: [
      {
        name: "first_name",
        source: {
          kind: "customer",
          path: ["profile", "customer", "displayName"],
        },
      },
      // Unused and unfinished: never blocks, publication drops it.
      { name: "later", source: { kind: "discount" } },
      // Unused and complete: kept in configured order.
      {
        name: "spare",
        source: {
          kind: "customer",
          path: ["activity", "stats", "favoriteProduct"],
        },
      },
    ],
  };

  test("an incomplete draft saves with broken references, missing translations and an unused definition", () => {
    expect<unknown>(draft(broken)).toEqual(broken);
    const problems = emailDraftProblems(draft(broken));
    expect(problems).toEqual([
      {
        _tag: "ComponentIncomplete",
        index: 1,
        componentId: "cta",
        field: "href",
      },
      {
        _tag: "ComponentIncomplete",
        index: 2,
        componentId: "contact",
        field: "fields",
      },
      {
        _tag: "ValueUnknown",
        name: "removed",
        at: { field: "component", componentId: "contact" },
      },
      {
        _tag: "ValueUnknown",
        name: "removed",
        at: { locale: "cs-CZ", field: "subject" },
      },
      {
        _tag: "TextMissing",
        locale: "en-US",
        componentId: "intro",
        textKey: "intro",
      },
      {
        _tag: "TextMissing",
        locale: "en-US",
        componentId: "cta",
        textKey: "cta",
      },
    ]);
    expect(problems.map(englishEmailDocumentProblem)).toContain(
      "Missing text intro: en-US."
    );
    expect(Result.isFailure(publish(broken))).toBe(true);
  });

  test("a removed used definition marks every use; unused definitions are listed separately", () => {
    const removed = {
      ...broken,
      values: broken.values.filter((value) => value.name !== "first_name"),
    };
    const problems = emailDraftProblems(draft(removed));
    expect(
      problems.filter(
        (problem) =>
          problem._tag === "ValueUnknown" && problem.name === "first_name"
      )
    ).toEqual([
      {
        _tag: "ValueUnknown",
        name: "first_name",
        at: {
          locale: "cs-CZ",
          field: "text",
          componentId: "intro",
          textKey: "intro",
        },
      },
    ]);
    expect([...referencedEmailValueNames(draft(removed))].sort()).toEqual([
      "first_name",
      "removed",
    ]);
  });

  test("repairing published content publishes and prunes only unused unfinished definitions", () => {
    const repaired = {
      ...broken,
      structure: [
        broken.structure[0],
        { ...broken.structure[1], href: "https://workspace.deskohub.test/" },
      ],
      translations: {
        "cs-CZ": {
          ...broken.translations["cs-CZ"],
          subject: [{ _tag: "Text", text: "Ahoj" }],
        },
        "en-US": {
          subject: [{ _tag: "Text", text: "Hello" }],
          texts: {
            intro: [{ _tag: "Text", text: "Hi" }],
            cta: [{ _tag: "Text", text: "Book" }],
          },
        },
      },
    };
    expect(emailDraftProblems(draft(repaired))).toEqual([]);
    const document = Result.getOrThrow(publish(repaired));
    expect(document.values.map((value): string => value.name)).toEqual([
      "first_name",
      "spare",
    ]);
    expect<ReadonlyArray<string>>(requiredEmailValueNames(document)).toEqual([
      "first_name",
    ]);
  });

  test("a referenced unfinished definition blocks with its own problem", () => {
    const referenced = {
      ...richDocument,
      values: [
        { name: "offer", source: { kind: "discount" } },
        richDocument.values[1],
      ],
    };
    expect(emailDraftProblems(draft(referenced))).toEqual([
      { _tag: "ValueIncomplete", index: 0, name: "offer", field: "discountId" },
      { _tag: "ValueIncomplete", index: 0, name: "offer", field: "validDays" },
    ]);
    expect(Result.isFailure(publish(referenced))).toBe(true);
  });

  test("settings of another component or source kind drop at publication", () => {
    const stray = {
      ...richDocument,
      structure: [
        { ...richDocument.structure[0], width: 320 },
        ...richDocument.structure.slice(1),
      ],
      values: [
        richDocument.values[0],
        {
          ...firstName,
          source: { ...firstName.source, discountId },
        },
      ],
    };
    expect(emailDraftProblems(draft(stray))).toEqual([]);
    const document = Result.getOrThrow(publish(stray));
    expect(document.structure[0]).not.toHaveProperty("width");
    expect(document.values[1]?.source).not.toHaveProperty("discountId");
  });

  test("repeated unused definitions drop at publication; the first stays", () => {
    const spare = {
      name: "spare",
      source: {
        kind: "customer",
        path: ["activity", "stats", "favoriteProduct"],
      },
    };
    const repeated = {
      ...richDocument,
      values: [
        ...richDocument.values,
        spare,
        { ...spare, fallback: { "en-US": "x" } },
      ],
    };
    expect(emailDraftProblems(draft(repeated))).toEqual([]);
    const document = Result.getOrThrow(publish(repeated));
    expect(document.values.map((value): string => value.name)).toEqual([
      "offer",
      "first_name",
      "spare",
    ]);
    expect(document.values[2]?.fallback).toBeUndefined();
  });

  test("blocks publication and reports a missing purpose or invalid components", () => {
    const { purpose: _, ...withoutPurpose } = richDocument;
    const cases = [
      {
        input: withoutPurpose,
        problem: { _tag: "PurposeMissing" },
      },
      {
        input: {
          ...richDocument,
          structure: [
            ...richDocument.structure,
            { _tag: "Divider", id: "rule" },
          ],
        },
        problem: { _tag: "ComponentIdDuplicate", componentId: "rule" },
      },
      {
        input: {
          ...richDocument,
          structure: richDocument.structure.map((component) =>
            component._tag === "TextList"
              ? { ...component, items: [] }
              : component
          ),
        },
        problem: {
          _tag: "ComponentIncomplete",
          componentId: "list",
          field: "items",
        },
      },
      {
        input: {
          ...richDocument,
          structure: richDocument.structure.map((component) =>
            component._tag === "Image" ? { ...component, width: 0 } : component
          ),
        },
        problem: {
          _tag: "ComponentIncomplete",
          componentId: "image",
          field: "settings",
        },
      },
    ];

    for (const { input, problem } of cases) {
      expect(emailDraftProblems(draft(input))).toMatchObject([problem]);
      expect(Result.isFailure(publish(input))).toBe(true);
    }
  });
});

describe("publication problems", () => {
  const text = [{ _tag: "Text", text: "Hello" }] as const;
  const translation = { subject: text, preheader: [], texts: { body: text } };
  const body = { _tag: "Paragraph", id: "body", textKey: "body" };
  const document = {
    purpose: "marketing",
    templateKey: "workspace",
    structure: [body],
    translations: { "cs-CZ": translation, "en-US": translation },
    values: [],
  };
  const problems = (input: Schema.JsonObject) =>
    emailPublicationProblems(Schema.decodeUnknownSync(EmailDocument)(input));
  const bothLanguages = (overrides: Schema.JsonObject) => ({
    "cs-CZ": { ...translation, ...overrides },
    "en-US": { ...translation, ...overrides },
  });
  const email = {
    name: "email",
    source: { kind: "customer", path: ["profile", "customer", "email"] },
  };
  const customer = {
    name: "customer",
    source: {
      kind: "customer",
      path: ["profile", "customer"],
      fields: [["displayName"]],
    },
  };
  const reservations = {
    name: "reservations",
    source: {
      kind: "customer",
      path: ["activity", "reservations"],
      fields: [["id"], ["startsAt"]],
      limit: 3,
    },
  };
  const discount = {
    name: "discount",
    source: { kind: "discount", discountId, validDays: 30 },
  };
  const value = (name: string, field?: readonly string[]) => ({
    _tag: "Value",
    name,
    ...(field && { field }),
  });
  const bodyField = (...field: string[]) => ({ field, labelKey: "body" });

  test("a complete document has none", () => {
    expect(problems(document)).toEqual([]);
  });

  test("only Czech is required: every other language is optional", () => {
    expect(
      problems({ ...document, translations: { "cs-CZ": translation } })
    ).toEqual([]);
    expect(
      problems({ ...document, translations: { "en-US": translation } })
    ).toEqual(["Missing language: cs-CZ."]);
    expect(
      problems({
        ...document,
        translations: { "cs-CZ": translation, "de-DE": translation },
      })
    ).toEqual([]);
  });

  test("every locale's fallback chain reaches the required language", () => {
    for (const locale of supportedLocales) {
      expect([locale, ...getLocaleDefinition(locale).fallbackChain]).toContain(
        requiredEmailLocale
      );
    }
  });

  test("reports an empty body, duplicate used names, then a missing Czech translation; duplicate ids name the id", () => {
    expect(
      problems({
        ...document,
        structure: [],
        values: [email, email],
        translations: {
          "en-US": { ...translation, subject: [value("email")] },
        },
      })
    ).toEqual([
      "Body is empty.",
      "Duplicate value name: email.",
      "Missing language: cs-CZ.",
    ]);
    // Unused repeated definitions never block.
    expect(problems({ ...document, values: [email, email] })).toEqual([]);
    expect(
      problems({
        ...document,
        structure: [body, body],
      })
    ).toEqual(["Duplicate component id: body."]);
  });

  test("reports invalid customer selections that something uses, with the reason", () => {
    expect(
      problems({
        ...document,
        values: [
          email,
          { name: "nowhere", source: { kind: "customer", path: ["nope"] } },
          { name: "bare", source: { kind: "customer", path: ["profile"] } },
          { name: "unused", source: { kind: "customer", path: ["nope"] } },
        ],
        translations: bothLanguages({
          subject: [value("nowhere"), value("bare")],
        }),
      })
    ).toEqual([
      "Invalid customer selection: nowhere (unknown-path).",
      "Invalid customer selection: bare (fields-required).",
    ]);
  });

  test("a subject needs a value or nonblank text", () => {
    expect(
      problems({
        ...document,
        values: [email],
        translations: {
          "cs-CZ": { ...translation, subject: [] },
          "en-US": {
            ...translation,
            subject: [
              { _tag: "Text", text: "  " },
              { _tag: "Text", text: "" },
            ],
          },
        },
      })
    ).toEqual(["Empty subject: cs-CZ.", "Empty subject: en-US."]);
    expect(
      problems({
        ...document,
        values: [email],
        translations: bothLanguages({ subject: [value("email")] }),
      })
    ).toEqual([]);
  });

  test("reports missing and empty texts per language and component", () => {
    expect(
      problems({
        ...document,
        structure: [
          { _tag: "Paragraph", id: "body", textKey: "body" },
          { _tag: "Heading", id: "title", textKey: "title", level: 1 },
        ],
        values: [email],
        translations: {
          "cs-CZ": {
            ...translation,
            texts: { body: [{ _tag: "Text", text: " " }] },
          },
          "en-US": { ...translation, texts: { body: [value("email")] } },
        },
      })
    ).toEqual([
      "Empty text body: cs-CZ.",
      "Missing text title: cs-CZ.",
      "Missing text title: en-US.",
    ]);
  });

  test("an image's alt text may be empty, but must exist; a component sharing its key still needs text", () => {
    const image = {
      _tag: "Image",
      id: "image",
      src: "https://workspace.deskohub.test/image.png",
      altKey: "alt",
    };
    expect(
      problems({
        ...document,
        structure: [...document.structure, image],
        translations: {
          "cs-CZ": { ...translation, texts: { body: text, alt: [] } },
          "en-US": translation,
        },
      })
    ).toEqual(["Missing text alt: en-US."]);
    expect(
      problems({
        ...document,
        structure: [...document.structure, { ...image, altKey: "body" }],
        translations: bothLanguages({ texts: { body: [] } }),
      })
    ).toEqual(["Empty text body: cs-CZ.", "Empty text body: en-US."]);
  });

  test("checks inline values in subject, preheader, reason, then texts", () => {
    expect(
      problems({
        ...document,
        values: [customer],
        translations: {
          "cs-CZ": {
            subject: [...text, value("customer")],
            preheader: [value("customer")],
            operationalReason: [value("customer")],
            texts: { body: [value("customer")] },
          },
          "en-US": translation,
        },
      })
    ).toEqual([
      "Invalid scalar value customer (subject, cs-CZ).",
      "Invalid scalar value customer (preheader, cs-CZ).",
      "Invalid scalar value customer (operationalReason, cs-CZ).",
      "Invalid scalar value customer (body, text body, cs-CZ).",
    ]);
    expect(
      problems({
        ...document,
        translations: {
          "cs-CZ": {
            subject: [...text, value("subject")],
            preheader: [value("preheader")],
            operationalReason: [value("reason")],
            texts: { body: [value("body")] },
          },
          "en-US": translation,
        },
      })
    ).toEqual([
      "Unknown value subject (subject, cs-CZ).",
      "Unknown value preheader (preheader, cs-CZ).",
      "Unknown value reason (operationalReason, cs-CZ).",
      "Unknown value body (body, text body, cs-CZ).",
    ]);
  });

  test.each<[string, readonly string[] | undefined, boolean]>([
    ["discount", ["code"], true],
    ["discount", ["expiresAt"], true],
    ["discount", undefined, false],
    ["discount", ["validDays"], false],
    ["discount", ["code", "extra"], false],
    ["email", undefined, true],
    ["email", ["domain"], false],
    ["customer", undefined, false],
    ["customer", ["displayName"], true],
    ["customer", ["email"], false],
    ["customer", ["missing"], false],
    ["reservations", undefined, false],
    ["reservations", ["id"], false],
  ])("an inline %s value at %p is valid: %p", (name, field, valid) => {
    expect(
      problems({
        ...document,
        values: [email, customer, reservations, discount],
        translations: bothLanguages({ subject: [value(name, field)] }),
      })
    ).toEqual(
      valid
        ? []
        : [
            `Invalid scalar value ${name} (subject, cs-CZ).`,
            `Invalid scalar value ${name} (subject, en-US).`,
          ]
    );
  });

  test("matches each valued component to its value's source", () => {
    const offer = {
      _tag: "Offer",
      id: "offer",
      labelKey: "body",
      href: "https://workspace.deskohub.test/",
    };
    expect(
      problems({
        ...document,
        values: [email, customer, reservations, discount],
        structure: [
          { ...offer, id: "ghost", value: "ghost" },
          { ...offer, id: "offer-customer", value: "customer" },
          { ...offer, id: "offer-discount", value: "discount" },
          {
            _tag: "Record",
            id: "record-discount",
            value: "discount",
            fields: [bodyField("code")],
          },
          {
            _tag: "Record",
            id: "record-list",
            value: "reservations",
            fields: [bodyField("id")],
          },
          { _tag: "List", id: "list-record", value: "customer" },
          {
            _tag: "Record",
            id: "record-scalar",
            value: "email",
            fields: [bodyField("id")],
          },
          {
            _tag: "Record",
            id: "record",
            value: "customer",
            fields: [bodyField("displayName")],
          },
        ],
      })
    ).toEqual([
      "Unknown value ghost (ghost).",
      "Component offer-customer requires a discount value: customer.",
      "Component record-discount requires a customer value: discount.",
      "Component record-list requires a record value: reservations.",
      "Component list-record requires a list value: customer.",
      "Component record-scalar requires a record value: email.",
    ]);
  });

  test("a valued component whose selection points nowhere reports only the selection", () => {
    expect(
      problems({
        ...document,
        values: [
          { name: "nowhere", source: { kind: "customer", path: ["x"] } },
        ],
        structure: [
          ...document.structure,
          { _tag: "List", id: "list", value: "nowhere" },
        ],
      })
    ).toEqual(["Invalid customer selection: nowhere (unknown-path)."]);
  });

  test("keeps list sorting, limits, and fields within the selected source", () => {
    const list = {
      _tag: "List",
      id: "list",
      value: "reservations",
      fields: [bodyField("id")],
    };
    const listProblems = (overrides: Schema.JsonObject) =>
      problems({
        ...document,
        values: [reservations],
        structure: [...document.structure, { ...list, ...overrides }],
      });

    expect(
      listProblems({ sort: { path: ["id"], direction: "asc" }, limit: 3 })
    ).toEqual([]);
    expect(
      listProblems({ sort: { path: ["status"], direction: "asc" } })
    ).toEqual(["Unselected list sort field: reservations."]);
    expect(
      listProblems({ sort: { path: ["createdAt"], direction: "asc" } })
    ).toEqual(["Unselected list sort field: reservations."]);
    expect(listProblems({ limit: 4 })).toEqual([
      "List component limit exceeds selected source: reservations.",
    ]);
    const { fields: _, ...fieldless } = list;
    expect(
      problems({
        ...document,
        values: [reservations],
        structure: [...document.structure, fieldless],
      })
    ).toEqual(["Record fields required: reservations."]);
    expect(
      listProblems({
        sort: { path: ["missing"], direction: "desc" },
        limit: 9,
        fields: [bodyField("id"), bodyField("createdAt")],
      })
    ).toEqual([
      "Unselected list sort field: reservations.",
      "List component limit exceeds selected source: reservations.",
      "Unselected component field: reservations.",
    ]);
    expect(listProblems({ fields: [bodyField("status")] })).toEqual([
      "Unselected component field: reservations.",
    ]);
  });

  test("an unbounded source accepts any list limit", () => {
    const { limit: _, ...unbounded } = reservations.source;
    expect(
      problems({
        ...document,
        values: [{ ...reservations, source: unbounded }],
        structure: [
          ...document.structure,
          {
            _tag: "List",
            id: "list",
            value: "reservations",
            fields: [bodyField("id")],
            limit: 50,
          },
        ],
      })
    ).toEqual([]);
  });

  test("record components need selected scalar fields", () => {
    const record = { _tag: "Record", id: "record", value: "customer" };
    const recordProblems = (
      fields: ReadonlyArray<ReturnType<typeof bodyField>>
    ) =>
      problems({
        ...document,
        values: [customer],
        structure: [...document.structure, { ...record, fields }],
      });

    expect(recordProblems([bodyField("displayName")])).toEqual([]);
    expect(recordProblems([bodyField("email")])).toEqual([
      "Unselected component field: customer.",
    ]);
  });
});

describe("trigger values, dynamic button links, and block conditions", () => {
  const passReminderDocument = {
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
      "cs-CZ": {
        subject: [
          { _tag: "Text", text: "Končí " },
          { _tag: "Value", name: "pass", field: ["endsOn"] },
        ],
        preheader: [{ _tag: "Value", name: "pass", field: ["tier"] }],
        texts: {
          greeting_named: [
            { _tag: "Text", text: "Ahoj " },
            { _tag: "Value", name: "pass", field: ["firstName"] },
          ],
          greeting_unnamed: [{ _tag: "Text", text: "Dobrý den," }],
          desk_note: [
            { _tag: "Text", text: "Stůl " },
            { _tag: "Value", name: "pass", field: ["deskLabel"], bold: true },
            { _tag: "Text", text: ", další období od " },
            { _tag: "Value", name: "pass", field: ["renewalStartsOn"] },
          ],
          renew_label: [{ _tag: "Text", text: "Obnovit" }],
        },
      },
    },
  };

  test("publishes trigger values with conditional blocks and dynamic button links", () => {
    expect(emailDraftProblems(draft(passReminderDocument))).toEqual([]);
    const published = Result.getOrThrow(publish(passReminderDocument));
    expect(emailDocumentRequiredTriggers(published)).toEqual([
      "unlimited-ending",
    ]);
    expect(emailDocumentUsesDiscounts(published)).toBe(false);
    expect<ReadonlyArray<string>>(requiredEmailValueNames(published)).toEqual([
      "pass",
    ]);
    expect([...referencedEmailValueNames(published)]).toEqual(["pass"]);
  });

  test("rejects URL trigger fields inline, non-URL fields on buttons, and dual button destinations", () => {
    const inlineUrl = structuredClone(passReminderDocument);
    inlineUrl.translations["cs-CZ"].subject = [
      { _tag: "Value", name: "pass", field: ["actionUrl"] },
    ];
    expect(tags(emailDraftProblems(draft(inlineUrl)))).toContain(
      "ValueReferenceInvalid"
    );
    expect(Result.isFailure(publish(inlineUrl))).toBe(true);

    const nonUrlButton = structuredClone(passReminderDocument);
    const nonUrlRenew = nonUrlButton.structure[3];
    if (nonUrlRenew === undefined) throw new Error("The renew button is gone.");
    nonUrlRenew.hrefValue = { name: "pass", field: ["endsOn"] };
    expect(tags(emailDraftProblems(draft(nonUrlButton)))).toContain(
      "ValueReferenceInvalid"
    );
    expect(Result.isFailure(publish(nonUrlButton))).toBe(true);

    const bothDestinations = structuredClone(passReminderDocument);
    const renew = bothDestinations.structure[3];
    if (renew === undefined) throw new Error("The renew button is gone.");
    const renewWithHref = { ...renew, href: "https://workspace.deskohub.cz/" };
    bothDestinations.structure[3] = renewWithHref;
    expect(tags(emailDraftProblems(draft(bothDestinations)))).toContain(
      "ComponentIncomplete"
    );
    expect(Result.isFailure(publish(bothDestinations))).toBe(true);

    const badCondition = structuredClone(passReminderDocument);
    const greeting = badCondition.structure[0];
    if (greeting === undefined) throw new Error("The greeting is gone.");
    greeting.when = {
      name: "pass",
      field: ["remainingEntries"],
      present: true,
    };
    expect(tags(emailDraftProblems(draft(badCondition)))).toContain(
      "ValueReferenceInvalid"
    );
    expect(Result.isFailure(publish(badCondition))).toBe(true);
  });
});
