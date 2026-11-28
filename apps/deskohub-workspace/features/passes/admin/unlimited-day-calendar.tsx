import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import type { AdminPassDetail } from "./pass-reads";

const calendarStates = {
  issued: {
    label: m.passesCodeIssued,
    classes: "border-navy-blue bg-navy-blue text-white",
  },
  past: {
    label: m.passesPastDay,
    classes: "border-navy-blue/10 bg-navy-blue/10 text-navy-blue",
  },
  today: {
    label: m.passesToday,
    classes: "border-burned-orange bg-burned-orange/10 text-burned-orange-ink",
  },
  reserved: {
    label: m.passesFutureDay,
    classes: "border-navy-blue/15 bg-white text-navy-blue",
  },
  released: {
    label: m.passesReleased,
    classes: "border-navy-blue/10 bg-white text-navy-blue/65 line-through",
  },
};

function dayCalendarState(
  day: AdminPassDetail["days"][number],
  today: AdminPassDetail["today"]
): keyof typeof calendarStates {
  if (day.status === "cancelled" || day.status === "hold_expired")
    return "released";
  if (day.date === today) return "today";
  if (day.accessIssued) return "issued";
  if (day.date && day.date < today) return "past";
  return "reserved";
}

export function UnlimitedDayCalendar({
  detail,
  locale,
}: {
  readonly detail: Pick<AdminPassDetail, "days" | "today">;
  readonly locale: Locale;
}) {
  const days = detail.days.flatMap((day) =>
    day.date
      ? [
          {
            id: day.id,
            date: day.date,
            state: dayCalendarState(day, detail.today),
          },
        ]
      : []
  );
  if (days.length === 0) return null;
  const usedStates = new Set(days.map(({ state }) => state));
  return (
    <section>
      <h2 className="mb-3 text-xl">{m.passesUsage({}, { locale })}</h2>
      <div className="space-y-4 rounded-xl border border-navy-blue/10 bg-white p-4">
        <ol className="grid grid-cols-4 gap-1.5 sm:grid-cols-7 xl:grid-cols-10">
          {days.map(({ id, date, state }) => {
            const display = calendarStates[state];
            return (
              <li
                className={`rounded-lg border px-1 py-2 text-center text-xs font-semibold ${display.classes}`}
                key={id}
              >
                <time dateTime={date}>
                  {Temporal.PlainDate.from(date).toLocaleString(locale, {
                    month: "short",
                    day: "numeric",
                  })}
                </time>
                <span className="sr-only">
                  , {display.label({}, { locale })}
                </span>
              </li>
            );
          })}
        </ol>
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-navy-blue/70">
          {[...usedStates].map((state) => {
            const display = calendarStates[state];
            return (
              <li className="flex items-center gap-1.5" key={state}>
                <span
                  aria-hidden
                  className={`size-3 rounded-sm border ${display.classes}`}
                />
                {display.label({}, { locale })}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
