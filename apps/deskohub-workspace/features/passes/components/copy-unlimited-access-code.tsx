"use client";

import { Copy } from "lucide-react";
import { type Locale, m } from "@/features/i18n";
import { useClipboardCopy } from "@/shared/browser/use-clipboard-copy";
import { Button } from "@/shared/components/ui/button";

export function CopyUnlimitedAccessCode({
  code,
  locale,
}: {
  readonly code: string;
  readonly locale: Locale;
}) {
  const clipboard = useClipboardCopy();

  return (
    <div className="mt-6 grid justify-items-center gap-2">
      <Button
        onClick={() => void clipboard.copy(code)}
        shape="pill"
        variant="secondary"
      >
        <Copy aria-hidden="true" className="size-4" />
        {m.unlimitedAccessCopy({}, { locale })}
      </Button>
      <output className="text-center text-sm text-navy-blue/70">
        {clipboard.status === "copied" &&
          m.unlimitedAccessCopied({}, { locale })}
        {clipboard.status === "failed" &&
          m.unlimitedAccessCopyFailed({}, { locale })}
      </output>
    </div>
  );
}
