import { Lock } from "lucide-react";
import { type Locale, m } from "@/features/i18n";

export function EntryPackBookingNotice({
  locale,
}: {
  readonly locale: Locale;
}) {
  return (
    <p className="flex items-start gap-3 rounded-2xl bg-sunset-yellow/15 px-4 py-3 text-sm leading-6 text-navy-blue">
      <Lock aria-hidden className="mt-1 size-4 shrink-0" />
      <span>{m.coworkEntryPackBookingNotice({}, { locale })}</span>
    </p>
  );
}
