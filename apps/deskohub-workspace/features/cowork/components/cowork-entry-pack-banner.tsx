"use client";

import { AlertTriangle, Check, Ticket, X } from "lucide-react";
import { useRef } from "react";
import type { BookableEntryPack } from "@/features/cowork/cowork-entry-packs";
import { type Locale, m } from "@/features/i18n";
import { EntryPackMeter } from "@/features/passes/components/entry-pack-meter";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { cn } from "@/shared/utils";

export function CoworkEntryPackBanner({
  applying,
  locale,
  onAction,
  pack,
}: {
  readonly applying: boolean;
  readonly locale: Locale;
  readonly onAction: () => void;
  readonly pack: BookableEntryPack;
}) {
  const Icon = applying ? Check : Ticket;
  return (
    <div
      className={cn(
        "@container/entry-pack rounded-3xl border px-5 py-5 text-navy-blue sm:px-6",
        applying
          ? "border-aquamarine-green/70 bg-aquamarine-green/10"
          : "border-burned-orange/55 bg-burned-orange/5"
      )}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 @min-[460px]/entry-pack:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-full text-white sm:size-11",
              applying
                ? "bg-aquamarine-green text-navy-blue"
                : "bg-burned-orange"
            )}
          >
            <Icon aria-hidden className="size-5" />
          </span>
          <div className="min-w-0 space-y-2">
            <p className="text-lg leading-tight sm:text-xl">
              {applying
                ? m.coworkEntryPackApplied({}, { locale })
                : m.coworkEntryPackOffer({}, { locale })}
            </p>
            <EntryPackMeter
              applying={applying}
              entriesLeft={pack.entriesLeft}
              entryCount={pack.entryCount}
              inline
              locale={locale}
            />
          </div>
        </div>
        <div className="w-full @min-[460px]/entry-pack:w-auto">
          <Button
            fullWidth
            onClick={onAction}
            type="button"
            variant={applying ? "secondary" : "primary"}
          >
            {!applying && <Ticket aria-hidden className="size-5" />}
            {applying
              ? m.coworkEntryPackPayByCardInstead({}, { locale })
              : m.coworkEntryPackUse({}, { locale })}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CoworkEntryPackUnavailable({
  invalidLink,
  locale,
  onClear,
}: {
  readonly invalidLink: boolean;
  readonly locale: Locale;
  readonly onClear: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex items-start gap-4 rounded-3xl border p-5 text-navy-blue sm:p-6",
        invalidLink
          ? "border-navy-blue/10 bg-white/75 pe-10"
          : "border-sunset-yellow/60 bg-sunset-yellow/15"
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-navy-blue/8">
        <AlertTriangle aria-hidden className="size-5" />
      </span>
      <div className="space-y-2">
        <p className="text-lg leading-tight">
          {m.coworkEntryPackInvalid({}, { locale })}
        </p>
        <p className="text-sm leading-6 text-navy-blue/75">
          {invalidLink
            ? m.coworkEntryPackInvalidLinkDescription({}, { locale })
            : m.coworkEntryPackUnavailableDescription({}, { locale })}
        </p>
        {!invalidLink && (
          <Button onClick={onClear} type="button" variant="secondary">
            {m.coworkEntryPackPayByCardInstead({}, { locale })}
          </Button>
        )}
      </div>
      {invalidLink && (
        <Button
          aria-label={m.closeDialogLabel({}, { locale })}
          className="absolute end-1.5 top-1.5"
          onClick={onClear}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden className="size-4" />
        </Button>
      )}
    </div>
  );
}

export function CoworkEntryPackCardDialog({
  locale,
  onCancel,
  onConfirm,
  open,
}: {
  readonly locale: Locale;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
}) {
  const keepPack = useRef<HTMLButtonElement>(null);
  const invokingOption = useRef<HTMLElement>(null);
  return (
    <Dialog onOpenChange={(open) => !open && onCancel()} open={open}>
      <DialogContent
        locale={locale}
        onCloseAutoFocus={(event) => {
          if (invokingOption.current) {
            event.preventDefault();
            invokingOption.current.focus();
            invokingOption.current = null;
          }
        }}
        onOpenAutoFocus={(event) => {
          const focused = document.activeElement;
          invokingOption.current =
            focused instanceof HTMLElement ? focused : null;
          event.preventDefault();
          keepPack.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {m.coworkEntryPackSwitchTitle({}, { locale })}
          </DialogTitle>
          <DialogDescription>
            {m.coworkEntryPackSwitchDescription({}, { locale })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onConfirm} type="button" variant="secondary">
            {m.coworkEntryPackPayByCard({}, { locale })}
          </Button>
          <Button onClick={onCancel} ref={keepPack} type="button">
            {m.coworkEntryPackKeep({}, { locale })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
