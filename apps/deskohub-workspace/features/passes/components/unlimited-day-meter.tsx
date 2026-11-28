import { cn } from "@/shared/utils";
import { unlimitedPassDays } from "../pass-offer";

export function UnlimitedDayMeter({
  day,
  totalDays,
}: {
  readonly day: number;
  readonly totalDays: number;
}) {
  const days = Array.from({ length: totalDays }, (_, index) => index + 1);
  return (
    <div
      aria-hidden="true"
      className="flex gap-[3px]"
      style={
        totalDays > unlimitedPassDays
          ? { columnGap: `min(3px, ${40 / totalDays}%)` }
          : undefined
      }
    >
      {days.map((segment) => (
        <span
          className={cn(
            "h-2.5 min-w-0 flex-1 rounded-full",
            segment < day && "bg-navy-blue/18",
            segment === day && "bg-burned-orange",
            segment > day && "bg-aquamarine-green"
          )}
          key={segment}
        />
      ))}
    </div>
  );
}
