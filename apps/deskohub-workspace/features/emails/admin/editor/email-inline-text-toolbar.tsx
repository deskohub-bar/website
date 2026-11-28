"use client";

import { type Editor, useEditorState } from "@tiptap/react";
import { Bold, Braces, Italic, Link2 } from "lucide-react";
import { type ReactElement, useRef, useState } from "react";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { useRouteLocale } from "@/features/i18n/route-locale";
import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import {
  SearchablePicker,
  SearchablePickerItem,
} from "@/shared/components/ui/searchable-picker";
import { Toggle } from "@/shared/components/ui/toggle";
import { Tooltip } from "@/shared/components/ui/tooltip";
import type { EmailDraftValueDefinition } from "./email-draft-form";
import {
  emailInlineLinkKey,
  emailInlineLinkMark,
  emailInlineValueNode,
} from "./email-inline-parts";
import {
  type EmailScalarValueOption,
  emailScalarValueOptions,
  emailValueReferenceLabel,
} from "./email-value-options";
import { emailTriggerFieldLabel } from "./email-value-trigger-source";

const selectMarks = ({ editor }: { editor: Editor | null }) => {
  if (!editor) return undefined;
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    link: emailInlineLinkKey(editor.getAttributes(emailInlineLinkMark)),
  };
};

/**
 * The controls of one inline text editor: bold, italic and links for rich
 * texts, and value references for every text.
 */
export function EmailInlineTextToolbar({
  definitions,
  editor,
  links,
  mode,
}: {
  readonly definitions: readonly EmailDraftValueDefinition[];
  readonly editor: Editor | null;
  readonly links: Readonly<Record<string, string>>;
  readonly mode: "rich" | "plain";
}) {
  const locale = useRouteLocale();
  return (
    <div
      aria-label={m.emailsEditorInlineToolbarLabel({}, { locale })}
      className="flex shrink-0 items-center gap-0.5 py-0.5"
      role="toolbar"
    >
      {mode === "rich" && (
        <EmailInlineFormatting editor={editor} links={links} locale={locale} />
      )}
      <EmailInlineValuePicker
        definitions={definitions}
        editor={editor}
        locale={locale}
      />
    </div>
  );
}

function ToolbarHint({
  children,
  label,
}: {
  readonly children: ReactElement;
  readonly label: string;
}) {
  return <Tooltip trigger={children}>{label}</Tooltip>;
}

function EmailInlineFormatting({
  editor,
  links,
  locale,
}: {
  readonly editor: Editor | null;
  readonly links: Readonly<Record<string, string>>;
  readonly locale: Locale;
}) {
  // useEditorState selects again only on a transaction, so until the first
  // one it still holds the selection from the null editor.
  const marks =
    useEditorState({ editor, selector: selectMarks }) ??
    selectMarks({ editor });
  const boldLabel = m.emailsEditorInlineBold({}, { locale });
  const italicLabel = m.emailsEditorInlineItalic({}, { locale });
  return (
    <>
      <ToolbarHint label={boldLabel}>
        <Toggle
          aria-label={boldLabel}
          disabled={!editor}
          onPressedChange={() => editor?.chain().focus().toggleBold().run()}
          pressed={marks?.bold ?? false}
        >
          <Bold aria-hidden className="size-4" />
        </Toggle>
      </ToolbarHint>
      <ToolbarHint label={italicLabel}>
        <Toggle
          aria-label={italicLabel}
          disabled={!editor}
          onPressedChange={() => editor?.chain().focus().toggleItalic().run()}
          pressed={marks?.italic ?? false}
        >
          <Italic aria-hidden className="size-4" />
        </Toggle>
      </ToolbarHint>
      <EmailInlineLinkPicker
        currentLink={marks?.link}
        editor={editor}
        links={links}
        locale={locale}
      />
    </>
  );
}

function EmailInlineLinkPicker({
  currentLink,
  editor,
  links,
  locale,
}: {
  readonly currentLink: string | undefined;
  readonly editor: Editor | null;
  readonly links: Readonly<Record<string, string>>;
  readonly locale: Locale;
}) {
  const [open, setOpen] = useState(false);
  // Whether the menu closes on a choice, which hands focus back to the text.
  const chose = useRef(false);
  const destinations = Object.entries(links);
  const hasDestinations = destinations.length > 0;
  // A link to a removed destination can still be removed.
  const available =
    Boolean(editor) && (hasDestinations || currentLink !== undefined);
  const label = m.emailsEditorInlineLink({}, { locale });
  const unavailableHint = m.emailsEditorInlineLinkNone({}, { locale });

  const applyLink = (key: string | undefined) => {
    if (!editor) return;
    chose.current = true;
    const chain = editor.chain();
    // A caret inside a link changes or removes that whole link.
    if (editor.state.selection.empty)
      chain.extendMarkRange(emailInlineLinkMark);
    if (key === undefined) chain.unsetMark(emailInlineLinkMark).run();
    else chain.setMark(emailInlineLinkMark, { key }).run();
  };

  return (
    <DropdownMenu
      onOpenChange={(next) => setOpen(next && available)}
      open={open}
    >
      <ToolbarHint label={hasDestinations ? label : unavailableHint}>
        <DropdownMenuTrigger asChild>
          {/* Pressed while the caret is in a link. It stays focusable when the
          block has no destinations, so its hint can explain why. */}
          <Toggle
            aria-disabled={!available || undefined}
            aria-label={label}
            className="aria-disabled:opacity-50"
            pressed={currentLink !== undefined}
          >
            <Link2 aria-hidden className="size-4" />
          </Toggle>
        </DropdownMenuTrigger>
      </ToolbarHint>
      <DropdownMenuContent
        align="end"
        className="max-w-80"
        onCloseAutoFocus={(event) => {
          if (!chose.current) return;
          chose.current = false;
          event.preventDefault();
          editor?.commands.focus();
        }}
      >
        {destinations.map(([key, href]) => (
          <DropdownMenuCheckboxItem
            checked={currentLink === key}
            key={key}
            onSelect={() => applyLink(key)}
          >
            <span className="truncate">{href || key}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={currentLink === undefined}
          onSelect={() => applyLink(undefined)}
        >
          {m.emailsEditorInlineLinkRemove({}, { locale })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const optionValue = ({ name, field }: EmailScalarValueOption) =>
  JSON.stringify([name, ...(field ?? [])]);

function EmailInlineValuePicker({
  definitions,
  editor,
  locale,
}: {
  readonly definitions: readonly EmailDraftValueDefinition[];
  readonly editor: Editor | null;
  readonly locale: Locale;
}) {
  const options = emailScalarValueOptions(definitions);
  const label = m.emailsEditorInlineValueInsert({}, { locale });
  const searchLabel = m.emailsEditorInlineValueSearch({}, { locale });
  const discountFields = new Map([
    ["code", m.emailsEditorInlineValueDiscountCode({}, { locale })],
    ["expiresAt", m.emailsEditorInlineValueDiscountExpiry({}, { locale })],
  ]);
  const description = ({ name, field }: EmailScalarValueOption) => {
    const definition = definitions.find((candidate) => candidate.name === name);
    if (definition?.source?.kind === "discount" && field?.[0] !== undefined)
      return discountFields.get(field[0]);
    if (definition?.source?.kind === "trigger" && field?.[0] !== undefined)
      return emailTriggerFieldLabel(field[0], locale);
    return undefined;
  };

  const insert = (value: string) => {
    const option = options.find((option) => optionValue(option) === value);
    if (!editor || !option) return;
    editor
      .chain()
      .insertContent({
        type: emailInlineValueNode,
        attrs: {
          name: option.name,
          field: option.field ? [...option.field] : null,
        },
      })
      .run();
  };

  return (
    <SearchablePicker
      align="end"
      className="w-72"
      empty={
        options.length > 0
          ? m.emailsEditorInlineValueNoMatch({}, { locale })
          : m.emailsEditorInlineValueNone({}, { locale })
      }
      focusOnSelect={() => editor?.commands.focus()}
      onPick={insert}
      search={searchLabel}
      trigger={
        <Button
          aria-label={label}
          disabled={!editor}
          size="icon-sm"
          tone="muted"
          type="button"
          variant="ghost"
        >
          <Braces aria-hidden className="size-4" />
        </Button>
      }
      wrapTrigger={(trigger) => (
        <ToolbarHint label={label}>{trigger}</ToolbarHint>
      )}
    >
      {options.map((option) => {
        const reference = emailValueReferenceLabel(option);
        const hint = description(option);
        return (
          <SearchablePickerItem
            key={optionValue(option)}
            keywords={hint ? [hint] : undefined}
            label={reference}
            value={optionValue(option)}
          >
            <span className="min-w-0 truncate font-mono">{reference}</span>
            {hint && (
              <span className="ml-auto shrink-0 text-navy-blue/60 text-xs">
                {hint}
              </span>
            )}
          </SearchablePickerItem>
        );
      })}
    </SearchablePicker>
  );
}
