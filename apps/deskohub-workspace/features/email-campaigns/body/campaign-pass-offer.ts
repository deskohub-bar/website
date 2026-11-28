import { Node } from "@tiptap/core";
import { Predicate } from "effect";
import type { EntryPackSize, PassProduct } from "@/features/passes/pass-offer";
import { htmlAttributeText } from "./campaign-body-attribute-text";
import type { CampaignBodyAttributeValue } from "./campaign-body-document";

/** The pass products a campaign card can offer, by their catalog kind. */
export const campaignPassOfferProducts = [
  "entry-pack",
  "unlimited",
] as const satisfies ReadonlyArray<PassProduct["kind"]>;
export type CampaignPassOfferProduct =
  (typeof campaignPassOfferProducts)[number];

/** The Entry pack sizes a card can open its purchase page on. */
export const campaignPassOfferSizes = [
  5, 10,
] as const satisfies ReadonlyArray<EntryPackSize>;

export const isCampaignPassOfferProduct = (
  value: CampaignBodyAttributeValue | undefined
): value is CampaignPassOfferProduct =>
  campaignPassOfferProducts.some((product) => product === value);

export const isCampaignPassOfferSize = (
  value: CampaignBodyAttributeValue | undefined
): value is EntryPackSize =>
  campaignPassOfferSizes.some((size) => size === value);

/** A card's optional text: missing, null, and empty all mean none. */
export const campaignPassOfferText = (
  value: CampaignBodyAttributeValue | undefined
): string | undefined =>
  Predicate.isString(value) && value !== "" ? value : undefined;

// Markdown spells a card `[[pass: product size | Headline | Detail]]` on its
// own line; size, headline, and detail are optional, and nothing else may
// follow. Fields are trimmed, as stored texts never start or end with
// whitespace. A backslash escapes the next character, so `|`, `]`,
// backslashes, and line breaks can be text. Any product word parses, so a
// typo fails validation instead of sending as text.
const passOfferMarkdownPattern =
  /^\[\[pass:((?:\\[\s\S]|[^\\\]\n])*)\]\][^\S\n]*(?:\n|$)/;

/** Splits on the `|` that no backslash escapes. */
const passOfferFields = (inner: string) =>
  inner.split(/(?<=(?:^|[^\\])(?:\\\\)*)\|/);

const unescapePassOfferMarkdown = (text: string) =>
  text.replace(/\\([\s\S])/g, "$1");

/** Escapes what would end or split a field: `\`, `|`, `]`, line breaks. */
const escapePassOfferText = (text: string) =>
  text.replace(/[\\|\]\n]/g, "\\$&");

/**
 * A pass product as a clickable offer card: the golden Entry pack ticket or
 * the burgundy Unlimited pass ID card. `headline` and `detail` are the
 * campaign's own lines, such as a saving and the visits it covers.
 */
export const CampaignPassOffer = Node.create({
  name: "passOffer",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      product: {
        default: null,
        parseHTML: htmlAttributeText("data-pass-offer"),
      },
      size: {
        default: null,
        parseHTML: (element) => {
          const size = Number(element.getAttribute("data-size"));
          return isCampaignPassOfferSize(size) ? size : null;
        },
      },
      headline: {
        default: null,
        parseHTML: htmlAttributeText("data-headline"),
      },
      detail: { default: null, parseHTML: htmlAttributeText("data-detail") },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-pass-offer]" }];
  },

  renderHTML({ node }) {
    return [
      "div",
      {
        "data-pass-offer": node.attrs.product,
        "data-size": node.attrs.size,
        "data-headline": node.attrs.headline,
        "data-detail": node.attrs.detail,
      },
    ];
  },

  markdownTokenizer: {
    name: "passOffer",
    level: "block",
    start: (source) => source.indexOf("[[pass:"),
    tokenize: (source) => {
      const match = passOfferMarkdownPattern.exec(source);
      if (!match) return undefined;
      const fields = passOfferFields(match[1] ?? "").map((field) =>
        unescapePassOfferMarkdown(field.trim())
      );
      const [product = "", headline, detail] = fields;
      const [productName, size, ...extraWords] = product.split(/\s+/);
      // Text past the known fields would vanish from the card; refuse it.
      if (fields.length > 3 || extraWords.length > 0) {
        throw new Error(
          `A pass offer line takes a product, an optional size, a headline and a detail: ${match[0].trim()}`
        );
      }
      return {
        type: "passOffer",
        raw: match[0],
        product: productName ?? "",
        // A size that isn't a number stays text, for validation to reject.
        size: size === undefined || size === "" ? null : Number(size) || size,
        headline: headline || null,
        detail: detail || null,
      };
    },
  },

  parseMarkdown: (token) => ({
    type: "passOffer",
    attrs: {
      product: token.product,
      size: token.size,
      headline: token.headline,
      detail: token.detail,
    },
  }),

  renderMarkdown: (node) => {
    const product = [node.attrs?.product, node.attrs?.size]
      .filter((part) => part !== null && part !== undefined)
      .join(" ");
    const texts = [node.attrs?.headline, node.attrs?.detail]
      .map(campaignPassOfferText)
      .filter((text) => text !== undefined)
      .map(escapePassOfferText);
    return `[[pass: ${[product, ...texts].join(" | ")}]]`;
  },
});
