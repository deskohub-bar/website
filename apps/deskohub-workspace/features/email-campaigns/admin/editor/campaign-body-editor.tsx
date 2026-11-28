"use client";

import { Placeholder, UndoRedo } from "@tiptap/extensions";
import {
  EditorContent,
  type JSONContent,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react";
import { Option, Schema } from "effect";
import { useMemo, useRef } from "react";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { cn } from "@/shared/utils";
import { CampaignBodyNode } from "../../body/campaign-body-document";
import { campaignBodyExtensions } from "../../body/campaign-body-extensions";
import { CampaignCtaButton } from "../../body/campaign-cta-button";
import { campaignBodyColumnWidth } from "../../body/campaign-image";
import { CampaignPassOffer } from "../../body/campaign-pass-offer";
import { CampaignBodyToolbar } from "./campaign-body-toolbar";
import { CtaButtonNodeView } from "./cta-button-node-view";
import { PassOfferNodeView } from "./pass-offer-node-view";

/**
 * The shared content set plus editing-only behavior: history, hints, views.
 * `locale` is the admin's language for the empty-body hint; `contentLocale`
 * is the body's, for the customer copy its cards preview.
 */
const campaignBodyEditorExtensions = (
  locale: Locale,
  contentLocale: Locale
) => [
  ...campaignBodyExtensions.filter(
    (extension) =>
      extension.name !== CampaignCtaButton.name &&
      extension.name !== CampaignPassOffer.name
  ),
  CampaignCtaButton.extend({
    addNodeView: () => ReactNodeViewRenderer(CtaButtonNodeView),
  }),
  CampaignPassOffer.extend({
    addNodeView: () =>
      ReactNodeViewRenderer((props: ReactNodeViewProps) => (
        <PassOfferNodeView {...props} contentLocale={contentLocale} />
      )),
  }),
  UndoRedo,
  Placeholder.configure({
    placeholder: m.emailCampaignsEditorPlaceholder({}, { locale }),
  }),
];

/** A body node as TipTap takes it: the same JSON with mutable arrays. */
const editorContent = ({
  content,
  marks,
  ...node
}: CampaignBodyNode): JSONContent => ({
  ...node,
  ...(content && { content: content.map(editorContent) }),
  ...(marks && { marks: [...marks] }),
});

/** The editor's document as a body node. */
const decodeBodyNode = Schema.decodeUnknownOption(CampaignBodyNode);

/** Rich-text editor for one locale's campaign body. */
export function CampaignBodyEditor({
  contentLocale,
  id,
  invalid,
  label,
  onChange,
  value,
}: {
  /** The language of the body being written. */
  readonly contentLocale: Locale;
  readonly id?: string;
  readonly invalid?: boolean;
  readonly label: string;
  readonly onChange: (doc: CampaignBodyNode) => void;
  /** The initial document; later changes come from the editor itself. */
  readonly value: CampaignBodyNode;
}) {
  const locale = useRouteLocale();
  const extensions = useMemo(
    () => campaignBodyEditorExtensions(locale, contentLocale),
    [locale, contentLocale]
  );
  // The document the form holds, which the editor returns to after an edit
  // the body format can't hold.
  const held = useRef(value);
  const editor = useEditor({
    extensions,
    content: editorContent(value),
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": label,
        "aria-multiline": "true",
        lang: contentLocale,
        style: `--campaign-image-max-width:${campaignBodyColumnWidth}px`,
        ...(id && { id }),
        ...(invalid && { "aria-invalid": "true" }),
        class: cn(
          "min-h-80 px-4 py-3 text-[15px] leading-7 text-navy-blue focus:outline-none",
          "[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:font-semibold [&_h1]:text-2xl [&_h1]:leading-tight",
          "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-xl [&_h2]:leading-snug",
          "[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-semibold [&_h3]:text-lg",
          "[&_p]:my-2 [&_a]:text-burned-orange-ink [&_a]:underline",
          "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li_p]:my-0.5",
          "[&_hr]:my-5 [&_hr]:border-navy-blue/20",
          "[&_img]:my-3 [&_img]:block [&_img]:h-auto [&_img]:max-w-[min(100%,var(--campaign-image-max-width))] [&_img:not([width])]:w-[var(--campaign-image-max-width)] [&_img:not([data-rounded-corners=false])]:rounded-md [&_img.ProseMirror-selectednode]:ring-2 [&_img.ProseMirror-selectednode]:ring-navy-blue",
          "[&_img[data-align=center]]:mx-auto [&_img[data-align=right]]:ml-auto",
          "[&_hr.ProseMirror-selectednode]:border-navy-blue",
          "[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-navy-blue/40 [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]"
        ),
      },
    },
    // ProseMirror builds node attributes as null-prototype objects, which a
    // Server Action can't receive: React passes them as opaque references.
    // A structured clone gives the form plain objects.
    onUpdate: ({ editor }) => {
      const doc = decodeBodyNode(structuredClone(editor.getJSON()));
      if (Option.isSome(doc)) {
        held.current = doc.value;
        onChange(doc.value);
      } else {
        // The form never got this edit, so the editor mustn't show it.
        editor.commands.setContent(editorContent(held.current), {
          emitUpdate: false,
        });
      }
    },
  });

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-white focus-within:ring-2 focus-within:ring-burned-orange/40",
        invalid ? "border-burned-orange" : "border-navy-blue/20"
      )}
    >
      <CampaignBodyToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
