import { describe, expect, test } from "bun:test";
import type { JSONContent } from "@tiptap/core";
import { Effect } from "effect";
import { marked } from "marked";
import {
  campaignBodyFromMarkdown,
  campaignBodyToMarkdown,
} from "./campaign-body-markdown";

const fromMarkdown = (markdown: string) =>
  Effect.runSync(campaignBodyFromMarkdown(markdown));

const nodeTypes = (node: JSONContent): readonly (string | undefined)[] => [
  node.type,
  ...(node.content ?? []).flatMap(nodeTypes),
];

const markTypes = (node: JSONContent): readonly string[] => [
  ...(node.marks ?? []).map(({ type }) => type),
  ...(node.content ?? []).flatMap(markTypes),
];

describe("campaign body Markdown", () => {
  test("imports a bare URL as text, without a link", () => {
    const { doc } = fromMarkdown("Visit https://example.com today.");
    expect(markTypes(doc)).not.toContain("link");
  });

  test("reads a button line through the campaign extensions", () => {
    const { doc } = fromMarkdown("[[button: Book](https://example.com)]");
    expect(nodeTypes(doc)).toContain("ctaButton");
  });

  test("exports Markdown that imports as the same document", () => {
    const body = fromMarkdown(
      "# Heading\n\nSome **bold** text.\n\n- one\n- two\n\n[[button: Book](https://example.com)]"
    );
    expect(fromMarkdown(campaignBodyToMarkdown(body))).toEqual(body);
  });

  test("leaves the shared marked default as it was", () => {
    const tokens = marked.lexer("Visit https://example.com today.");
    expect(JSON.stringify(tokens)).toContain('"type":"link"');
    expect(marked.defaults.extensions).toBeFalsy();
  });
});
