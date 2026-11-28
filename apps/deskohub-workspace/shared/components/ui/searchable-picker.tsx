"use client";

import { includesSearchText } from "@deskohub/i18n/search-text";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  type ComboboxOpenChangeReason,
  ComboboxTrigger,
} from "@ui-sdk/react/combobox";
import { Check, Search } from "lucide-react";
import { type ReactElement, type ReactNode, useRef, useState } from "react";
import { cn } from "@/shared/utils";

export function SearchablePicker({
  trigger,
  triggerRole,
  wrapTrigger,
  search,
  empty,
  value = null,
  onPick,
  focusOnSelect,
  className,
  align = "start",
  children,
}: {
  readonly trigger: ReactElement;
  readonly triggerRole?: "combobox";
  readonly wrapTrigger?: (trigger: ReactElement) => ReactNode;
  readonly search: string;
  readonly empty: string;
  readonly value?: string | null;
  readonly onPick: (value: string) => void;
  readonly focusOnSelect?: false | (() => void);
  readonly className?: string;
  readonly align?: "start" | "end";
  readonly children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const closeReason = useRef<ComboboxOpenChangeReason | undefined>(undefined);
  const button = (
    <ComboboxTrigger
      aria-haspopup="listbox"
      ref={setAnchor}
      render={trigger}
      role={triggerRole}
    />
  );

  return (
    <Combobox
      announcement={() => null}
      autoHighlight="always"
      filter={({ label, keywords }, searchText) =>
        [label, ...(keywords ?? [])].some((text) =>
          includesSearchText(text, searchText)
        )
      }
      loop={false}
      onOpenChange={(open, { reason }) => {
        if (open) setQuery("");
        else closeReason.current = reason;
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
        const reason = closeReason.current;
        // The popup returns focus to its opener after the completion callback.
        queueMicrotask(() => {
          if (reason === "item-press") {
            if (focusOnSelect === false) return;
            if (focusOnSelect) focusOnSelect();
            else anchor?.focus({ preventScroll: true });
          } else if (reason === "escape-key" || reason === "trigger-press") {
            anchor?.focus({ preventScroll: true });
          }
        });
      }}
      onQueryChange={setQuery}
      onValueChange={(picked, details) => {
        if (details.reason === "item-press" && picked !== null) onPick(picked);
        else details.cancel();
      }}
      query={query}
      value={value}
    >
      {wrapTrigger ? wrapTrigger(button) : button}
      <ComboboxContent
        align={align}
        anchor={anchor}
        className={cn(
          "w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-[1.5rem] border border-navy-blue/12 bg-white text-navy-blue shadow-[0_24px_80px_-36px_rgba(0,2,79,0.65)] outline-none",
          className
        )}
        sideOffset={8}
      >
        <div className="flex items-center gap-2 border-navy-blue/10 border-b px-3">
          <Search className="size-4 shrink-0 text-navy-blue/55" aria-hidden />
          <ComboboxInput
            aria-label={search}
            autoFocus
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-navy-blue/55"
            placeholder={search}
          />
        </div>
        <ComboboxList className="max-h-72 scroll-py-1 overflow-auto p-1">
          {children}
        </ComboboxList>
        <ComboboxEmpty className="text-center text-navy-blue/65 text-sm data-empty:px-3 data-empty:py-4">
          {empty}
        </ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}

export function SearchablePickerItem({
  children,
  keywords,
  label,
  value,
}: {
  readonly children: ReactNode;
  readonly keywords?: string[];
  readonly label: string;
  readonly value: string;
}) {
  return (
    <ComboboxItem
      className="relative flex w-full cursor-default select-none items-center gap-2 rounded-xl py-2 pr-2 pl-8 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-navy-blue/5 [&[hidden]]:hidden"
      keywords={keywords}
      label={label}
      value={value}
    >
      <ComboboxItemIndicator className="absolute left-2">
        <Check className="size-4 text-burned-orange" aria-hidden />
      </ComboboxItemIndicator>
      {children}
    </ComboboxItem>
  );
}
