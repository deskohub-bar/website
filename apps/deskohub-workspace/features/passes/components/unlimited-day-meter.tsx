import { cn } from "@/shared/utils";
import { unlimitedPassDays } from "../pass-offer";

const days = Array.from({ length: unlimitedPassDays }, (_, index) => index + 1);

export function UnlimitedDayMeter({ day }: { readonly day: number }) {
  return (
    <div aria-hidden="true" className="flex gap-[3px]">
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
