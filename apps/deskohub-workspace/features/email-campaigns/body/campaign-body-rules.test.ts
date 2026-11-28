import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Option } from "effect";
import type { CampaignBodyNode } from "./campaign-body-document";
import {
  campaignBodyIssues,
  campaignBodyStructureIssues,
  campaignButtonLabelIssue,
  campaignPassOfferTextMaxLength,
  emptyCampaignBody,
  isCampaignBodyEmpty,
  isCampaignLinkHref,
} from "./campaign-body-rules";

const imageCloudName = Option.some("synthetic-cloud");

const doc = (
  ...content: ReadonlyArray<CampaignBodyNode>
): CampaignBodyNode => ({
  type: "doc",
  content: [...content],
});

const text = (value: string, marks?: CampaignBodyNode["marks"]) =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value };

const paragraph = (...content: ReadonlyArray<CampaignBodyNode>) => ({
  type: "paragraph",
  content: [...content],
});

const link = (href: string | null) =>
  paragraph(text("odkaz", [{ type: "link", attrs: { href, title: null } }]));

const image = (src: string) => ({
  type: "image",
  attrs: { src, alt: "Workspace", title: null },
});

const passOffer = (attrs: CampaignBodyNode["attrs"]) => ({
  type: "passOffer",
  attrs,
});

const cta = (attrs: CampaignBodyNode["attrs"]) => ({
  type: "ctaButton",
  attrs,
});

const cloudinaryImage =
  "https://res.cloudinary.com/synthetic-cloud/image/upload/v1/campaigns/autumn.jpg";

const issueTags = (
  body: CampaignBodyNode,
  cloudName: Option.Option<string> = imageCloudName
) => campaignBodyIssues(body, cloudName).map(({ _tag }) => _tag);

describe("campaignBodyIssues", () => {
  test("accepts links, images and buttons that follow the rules", () => {
    expect(
      issueTags(
        doc(
          link("https://workspace.deskohub.cz"),
          link(`mailto:${testEmailAddress("campaign")}`),
          image(cloudinaryImage),
          { type: "horizontalRule" },
          cta({ label: "Rezervovat", href: "https://workspace.deskohub.cz" })
        )
      )
    ).toEqual([]);
  });

  test("rejects a root that isn't a doc node", () => {
    expect(campaignBodyIssues(paragraph(text("x")), imageCloudName)).toEqual([
      expect.objectContaining({ _tag: "NotDocument", path: ["type"] }),
    ]);
  });

  test.each<[string, CampaignBodyNode]>([
    ["a node outside the content set", doc({ type: "table" })],
    [
      "a mark outside the content set",
      doc(paragraph(text("x", [{ type: "strike" }]))),
    ],
    ["invalid nesting", doc({ type: "bulletList", content: [text("x")] })],
  ])("rejects %s as invalid structure", (_name, body) => {
    expect(issueTags(body)).toEqual(["StructureInvalid"]);
  });

  test("checks the rules only on a body whose structure is valid", () => {
    expect(issueTags(doc(link("http://a"), { type: "table" }))).toEqual([
      "StructureInvalid",
    ]);
  });

  test.each([
    "javascript:alert(1)",
    "http://workspace.deskohub.cz",
    "data:text/html,hi",
    "/relative",
    null,
  ])("rejects the link %p", (href) => {
    expect(campaignBodyIssues(doc(link(href)), imageCloudName)).toEqual([
      expect.objectContaining({
        _tag: "LinkHrefInvalid",
        path: ["content", 0, "content", 0, "marks", 0, "attrs", "href"],
      }),
    ]);
  });

  test.each([
    "https://example.com/image.jpg",
    "https://res.cloudinary.com/another-cloud/image/upload/v1/a.jpg",
    "http://res.cloudinary.com/synthetic-cloud/image/upload/v1/a.jpg",
    "https://res.cloudinary.com/synthetic-cloud/video/upload/v1/a.mp4",
  ])("rejects the image %s", (src) => {
    expect(campaignBodyIssues(doc(image(src)), imageCloudName)).toEqual([
      expect.objectContaining({
        _tag: "ImageSourceInvalid",
        path: ["content", 0, "attrs", "src"],
      }),
    ]);
  });

  test("rejects every image without a configured Cloudinary account", () => {
    expect(issueTags(doc(image(cloudinaryImage)), Option.none())).toEqual([
      "ImageSourceInvalid",
    ]);
    expect(issueTags(doc(paragraph(text("x"))), Option.none())).toEqual([]);
  });

  test("rejects a button without a label", () => {
    expect(
      issueTags(doc(cta({ label: "  ", href: "https://deskohub.cz" })))
    ).toEqual(["ButtonLabelMissing"]);
  });

  test.each(["Book\rnow", "Book\r\nnow"])(
    "rejects the button label %p, which Markdown can't keep",
    (label) => {
      expect(
        issueTags(doc(cta({ label, href: "https://deskohub.cz" })))
      ).toEqual(["ButtonLabelLineBreaks"]);
    }
  );

  test.each([null, "javascript:void(0)"])(
    "rejects the button URL %p",
    (href) => {
      expect(
        campaignBodyIssues(doc(cta({ label: "Klik", href })), imageCloudName)
      ).toEqual([
        expect.objectContaining({
          _tag: "ButtonHrefInvalid",
          path: ["content", 0, "attrs", "href"],
        }),
      ]);
    }
  );

  test("reports every issue in document order", () => {
    expect(
      issueTags(
        doc(
          link("http://a"),
          image("https://example.com/a.png"),
          cta({ label: " ", href: "ftp://x" }),
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [link("data:x")] }],
          }
        )
      )
    ).toEqual([
      "LinkHrefInvalid",
      "ImageSourceInvalid",
      "ButtonLabelMissing",
      "ButtonHrefInvalid",
      "LinkHrefInvalid",
    ]);
  });
});

describe("campaignBodyIssues per node", () => {
  const issues = (body: CampaignBodyNode) =>
    campaignBodyIssues(body, imageCloudName).map(({ _tag, path }) => [
      _tag,
      path,
    ]);

  test("checks a node's link mark, leaving other marks alone", () => {
    expect(
      issues(
        doc(
          paragraph(
            text("x", [
              { type: "bold" },
              { type: "link", attrs: { href: "http://a", title: null } },
            ]),
            text("y", [{ type: "italic" }])
          )
        )
      )
    ).toEqual([
      [
        "LinkHrefInvalid",
        ["content", 0, "content", 0, "marks", 1, "attrs", "href"],
      ],
    ]);
  });

  test("reports an image's source, then its alignment, then its width", () => {
    expect(
      issues(
        doc({
          type: "image",
          attrs: { src: "https://example.com/a.png", align: "top", width: 1.5 },
        })
      )
    ).toEqual([
      ["ImageSourceInvalid", ["content", 0, "attrs", "src"]],
      ["ImageLayoutInvalid", ["content", 0, "attrs", "align"]],
      ["ImageLayoutInvalid", ["content", 0, "attrs", "width"]],
    ]);
  });

  test.each<[string, CampaignBodyNode["attrs"]]>([
    ["no layout", { src: cloudinaryImage }],
    ["a null layout", { src: cloudinaryImage, align: null, width: null }],
    ["a valid layout", { src: cloudinaryImage, align: "left", width: 320 }],
  ])("accepts an image with %s", (_name, attrs) => {
    expect(issues(doc({ type: "image", attrs }))).toEqual([]);
  });

  test("checks layout only on images", () => {
    expect(
      issues(
        doc(paragraph(), { type: "horizontalRule", attrs: { align: "x" } })
      )
    ).toEqual([]);
  });

  test.each<[string, CampaignBodyNode["attrs"]]>([
    ["only a product", { product: "unlimited" }],
    [
      "null optional fields",
      { product: "unlimited", size: null, headline: null, detail: null },
    ],
    ["empty texts", { product: "entry-pack", headline: "", detail: "" }],
    [
      "a size, headline and detail",
      {
        product: "entry-pack",
        size: 5,
        headline: "Save CZK 460",
        detail: "on 5 Reserved Desk visits",
      },
    ],
    [
      "a headline at the length limit",
      {
        product: "unlimited",
        headline: "x".repeat(campaignPassOfferTextMaxLength),
      },
    ],
  ])("accepts a pass offer with %s", (_name, attrs) => {
    expect(issues(doc(passOffer(attrs)))).toEqual([]);
  });

  test.each<[string, CampaignBodyNode["attrs"], ReadonlyArray<string>]>([
    ["no product", {}, ["PassOfferProductInvalid"]],
    [
      "an unknown product",
      { product: "unlimted" },
      ["PassOfferProductInvalid"],
    ],
    [
      "a size on an Unlimited pass",
      { product: "unlimited", size: 5 },
      ["PassOfferSizeInvalid"],
    ],
    [
      "an unsold size",
      { product: "entry-pack", size: 7 },
      ["PassOfferSizeInvalid"],
    ],
    [
      "a size in words",
      { product: "entry-pack", size: "five" },
      ["PassOfferSizeInvalid"],
    ],
    [
      "a line break in the headline",
      { product: "unlimited", headline: "Save\nmore" },
      ["PassOfferTextInvalid"],
    ],
    [
      "an over-long detail",
      {
        product: "unlimited",
        headline: "Save",
        detail: "x".repeat(campaignPassOfferTextMaxLength + 1),
      },
      ["PassOfferTextInvalid"],
    ],
    [
      "a number for a headline",
      { product: "unlimited", headline: 460 },
      ["PassOfferTextInvalid"],
    ],
    [
      "a detail without a headline",
      { product: "unlimited", detail: "across 20 visits" },
      ["PassOfferDetailWithoutHeadline"],
    ],
    [
      "a padded headline",
      { product: "unlimited", headline: " Save " },
      ["PassOfferTextInvalid"],
    ],
    [
      "a blank headline before a detail",
      { product: "unlimited", headline: "  ", detail: "across 20 visits" },
      ["PassOfferTextInvalid"],
    ],
  ])("rejects a pass offer with %s", (_name, attrs, tags) => {
    expect(issues(doc(passOffer(attrs))).map(([tag]) => tag)).toEqual([
      ...tags,
    ]);
  });

  test("points a pass offer's issue at the attribute at fault", () => {
    expect(issues(doc(passOffer({ product: "unlimited", size: 10 })))).toEqual([
      ["PassOfferSizeInvalid", ["content", 0, "attrs", "size"]],
    ]);
  });

  test("reports a button's label before its URL", () => {
    expect(issues(doc(cta({ label: "Book\rnow", href: "ftp://x" })))).toEqual([
      ["ButtonLabelLineBreaks", ["content", 0, "attrs", "label"]],
      ["ButtonHrefInvalid", ["content", 0, "attrs", "href"]],
    ]);
  });
});

describe("campaignBodyStructureIssues", () => {
  test("leaves unfinished links, images and buttons to the full rules", () => {
    expect(
      campaignBodyStructureIssues(
        doc(link("http://a"), image("https://example.com/a.png"), cta({}))
      )
    ).toEqual([]);
  });
});

describe("campaignButtonLabelIssue", () => {
  test.each<[string, string | null, string | undefined]>([
    ["a label", "Rezervovat", undefined],
    ["a line feed", "Book\nnow", undefined],
    ["no label", null, "ButtonLabelMissing"],
    ["a blank label", " ", "ButtonLabelMissing"],
    ["a carriage return", "Book\rnow", "ButtonLabelLineBreaks"],
  ])("judges %s", (_name, label, tag) => {
    expect(
      Option.getOrUndefined(
        Option.map(
          campaignButtonLabelIssue(label, ["label"]),
          ({ _tag }) => _tag
        )
      )
    ).toBe(tag);
  });
});

describe("isCampaignLinkHref", () => {
  test.each<[string | null, boolean]>([
    ["https://deskohub.cz", true],
    [`mailto:${testEmailAddress("team")}`, true],
    ["http://deskohub.cz", false],
    ["javascript:alert(1)", false],
    ["deskohub.cz", false],
    [null, false],
  ])("judges %p", (href, expected) => {
    expect(isCampaignLinkHref(href)).toBe(expected);
  });
});

describe("isCampaignBodyEmpty", () => {
  test.each<[string, CampaignBodyNode, boolean]>([
    ["the body nobody has written", emptyCampaignBody, true],
    ["blank text", doc(paragraph(text("   "))), true],
    ["text", doc(paragraph(text("Ahoj"))), false],
    ["an image", doc(image(cloudinaryImage)), false],
    ["a button", doc(cta({ label: "", href: "" })), false],
    ["a pass offer", doc(passOffer({ product: "unlimited" })), false],
    ["a rule", doc({ type: "horizontalRule" }), false],
  ])("judges %s", (_name, body, expected) => {
    expect(isCampaignBodyEmpty(body)).toBe(expected);
  });

  test("the body nobody has written passes the rules", () => {
    expect(issueTags(emptyCampaignBody)).toEqual([]);
  });
});
