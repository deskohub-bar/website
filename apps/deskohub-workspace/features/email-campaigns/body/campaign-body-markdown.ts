import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Effect } from "effect";
import {
  getDefaults,
  Hooks,
  Lexer,
  Marked,
  type MarkedExtension,
  type MarkedOptions,
  type marked,
  Parser,
  Renderer,
  TextRenderer,
  Tokenizer,
} from "marked";
import {
  type CampaignBodyDocument,
  type CampaignBodyNode,
  campaignBodyFormatVersion,
} from "./campaign-body-document";
import {
  campaignBodyExtensions,
  campaignBodySchema,
} from "./campaign-body-extensions";
import { emptyCampaignBody } from "./campaign-body-rules";
import { InvalidCampaignBody } from "./invalid-campaign-body";

/**
 * CommonMark plus GFM without bare-URL autolinks: the editor never links
 * typed text, so an exported `https://…` or `www.…` must import as text.
 */
const campaignMarked = new Marked({
  tokenizer: { url: () => undefined },
});

/**
 * `campaignMarked` in the shape the manager takes, the `marked` default
 * export. Like that export over its own shared instance, it delegates every
 * call to the instance and re-reads the instance's defaults after each
 * change, so the shared default is never read or changed.
 */
function campaignMarkedApi(
  src: string,
  options: MarkedOptions & { async: true }
): Promise<string>;
function campaignMarkedApi(
  src: string,
  options: MarkedOptions & { async: false }
): string;
function campaignMarkedApi(
  src: string,
  options?: MarkedOptions | null
): string | Promise<string>;
function campaignMarkedApi(src: string, options?: MarkedOptions | null) {
  return campaignMarked.parse(src, options);
}

/** The API after an instance change, with the instance's new defaults. */
const changedCampaignMarked = (): typeof marked => {
  campaignMarkedApi.defaults = campaignMarked.defaults;
  return campaignMarkedApi;
};

campaignMarkedApi.setOptions = (options: MarkedOptions): typeof marked => {
  campaignMarked.setOptions(options);
  return changedCampaignMarked();
};
campaignMarkedApi.options = campaignMarkedApi.setOptions;
campaignMarkedApi.getDefaults = getDefaults;
campaignMarkedApi.defaults = campaignMarked.defaults;
campaignMarkedApi.use = (...extensions: MarkedExtension[]): typeof marked => {
  campaignMarked.use(...extensions);
  return changedCampaignMarked();
};
campaignMarkedApi.walkTokens = campaignMarked.walkTokens.bind(campaignMarked);
campaignMarkedApi.parseInline = campaignMarked.parseInline;
campaignMarkedApi.Parser = Parser;
// The manager never renders HTML, so the static parser, which reads the
// options it is given, stands in for the instance one.
campaignMarkedApi.parser = Parser.parse;
campaignMarkedApi.Renderer = Renderer;
campaignMarkedApi.TextRenderer = TextRenderer;
campaignMarkedApi.Lexer = Lexer;
campaignMarkedApi.lexer = <ParserOutput = string, RendererOutput = string>(
  src: string,
  options?: MarkedOptions<ParserOutput, RendererOutput>
) =>
  options === undefined ? campaignMarked.lexer(src) : Lexer.lex(src, options);
campaignMarkedApi.Tokenizer = Tokenizer;
campaignMarkedApi.Hooks = Hooks;
campaignMarkedApi.parse = campaignMarkedApi;

const markdownManager = new MarkdownManager({
  marked: campaignMarkedApi,
  extensions: campaignBodyExtensions,
});

/** The TipTap document Markdown spells, not yet checked against any rules. */
const markdownDoc = (
  markdown: string
): Effect.Effect<CampaignBodyNode | JSONContent, InvalidCampaignBody> =>
  markdown.trim() === ""
    ? Effect.succeed(emptyCampaignBody)
    : Effect.try({
        try: () => markdownManager.parse(markdown),
        catch: InvalidCampaignBody.fromCause,
      });

/**
 * Spells a Markdown body as a versioned TipTap document, not yet checked
 * against any content rules. Besides CommonMark, a line
 * `[[button: Label](https://example.com)]` makes a button, a line
 * `[[pass: entry-pack 5 | Headline | Detail]]` makes a pass offer card, and an
 * image line may end in `{align=center width=240}`.
 */
export const campaignBodyFromMarkdown = (markdown: string) =>
  markdownDoc(markdown).pipe(
    Effect.map((doc) => ({ formatVersion: campaignBodyFormatVersion, doc }))
  );

/** Serializes a campaign body back to the Markdown the parser accepts. */
export const campaignBodyToMarkdown = (body: CampaignBodyDocument): string =>
  markdownManager.serialize(campaignBodySchema.nodeFromJSON(body.doc).toJSON());
