import { type Extensions, getSchema } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { htmlAttributeText } from "./campaign-body-attribute-text";
import { CampaignCtaButton } from "./campaign-cta-button";
import { CampaignImage } from "./campaign-image";
import { CampaignPassOffer } from "./campaign-pass-offer";

const campaignHeadingLevels = [1, 2, 3] as const;

/**
 * An ordered list. A pasted list whose `start` isn't a number counts from 1,
 * as the browser shows it, so the paste fits the body format.
 */
const CampaignOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      start: {
        default: 1,
        parseHTML: (element) => {
          const start = Number.parseInt(
            element.getAttribute("start") ?? "",
            10
          );
          return Number.isFinite(start) ? start : 1;
        },
      },
    };
  },
});

/** A link whose pasted text attributes stay text, digits included. */
const CampaignLink = Link.extend({
  addAttributes() {
    const {
      target = null,
      rel = null,
      class: className = null,
    } = this.options.HTMLAttributes;
    return {
      ...this.parent?.(),
      target: { default: target, parseHTML: htmlAttributeText("target") },
      rel: { default: rel, parseHTML: htmlAttributeText("rel") },
      class: { default: className, parseHTML: htmlAttributeText("class") },
      title: { default: null, parseHTML: htmlAttributeText("title") },
    };
  },
});

/**
 * The campaign body content set. The editor, renderer, validator, and Markdown
 * parser all build on this list, so they agree on one document schema. It
 * must stay free of DOM and React dependencies; the editor adds its own
 * editing-only extensions (history, placeholder) on top.
 */
export const campaignBodyExtensions: Extensions = [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: [...campaignHeadingLevels] }),
  Bold,
  Italic,
  CampaignLink.configure({
    autolink: false,
    defaultProtocol: "https",
    HTMLAttributes: { rel: null, target: null, class: null },
    openOnClick: false,
  }),
  BulletList,
  CampaignOrderedList,
  ListItem,
  CampaignImage.configure({ allowBase64: false, inline: false }),
  HorizontalRule,
  CampaignCtaButton,
  CampaignPassOffer,
];

export const campaignBodySchema = getSchema(campaignBodyExtensions);
