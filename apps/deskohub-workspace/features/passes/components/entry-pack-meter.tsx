import { type Locale, m } from "@/features/i18n";
import { cn } from "@/shared/utils";

export function EntryPackMeter({
  applying = false,
  className,
  entriesLeft,
  entryCount,
  inline = false,
  locale,
}: {
  readonly applying?: boolean;
  readonly className?: string;
  readonly entriesLeft: number;
  readonly entryCount: number;
  readonly inline?: boolean;
  readonly locale: Locale;
}) {
  const selected = applying && entriesLeft > 0 ? 1 : 0;
  const available = entriesLeft - selected;
  const remainingMessage = inline
    ? m.coworkEntryPackRemaining
    : m.entryPackEntriesLeft;
  const used = entryCount - entriesLeft;
  const segments = [
    { count: used, color: "bg-navy-blue/20" },
    { count: selected, color: "bg-burned-orange" },
    { count: available, color: "bg-emerald-400" },
  ];

  return (
    <div
      className={cn(
        "min-w-0",
        inline
          ? "flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
          : "space-y-2",
        className
      )}
    >
      <p className={cn("font-semibold leading-tight", inline && "order-2")}>
        {applying
          ? m.entryPackEntriesLeftAfter({ left: available }, { locale })
          : remainingMessage(
              { left: entriesLeft, total: entryCount },
              { locale }
            )}
      </p>
      <div
        aria-hidden="true"
        className={cn(
          "flex gap-1",
          inline && "order-1 min-w-16 max-w-32 flex-1 basis-16"
        )}
      >
        {segments.flatMap(({ color, count }) =>
          Array.from({ length: count }, (_, position) => (
            <span
              className={cn("h-2 min-w-0 flex-1 rounded-full", color)}
              // biome-ignore lint/suspicious/noArrayIndexKey: Segments are fixed, decorative slots with no local state.
              key={`${color}-${position}`}
            />
          ))
        )}
      </div>
    </div>
  );
}
