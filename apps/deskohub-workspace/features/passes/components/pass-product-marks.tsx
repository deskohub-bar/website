import { cn } from "@/shared/utils";

type PassProductMarksProps = {
  /**
   * The background the marks sit on. On a dark one the ticket is paler and
   * needs no outline.
   */
  readonly surface?: "light" | "dark";
  /**
   * Sizes the marks through `font-size`: each mark is about 1.4em wide, so
   * they follow the text beside them unless a class sets another size.
   */
  readonly className?: string;
};

/** The ticket outline: a rounded rectangle with a perforation notch at the top and bottom of the stub. */
const ticketOutline =
  "M2.5 .5H15.8A2.25 2.25 0 0 0 20.2 .5H23.5A2 2 0 0 1 25.5 2.5V14.5A2 2 0 0 1 23.5 16.5H20.2A2.25 2.25 0 0 0 15.8 16.5H2.5A2 2 0 0 1 .5 14.5V2.5A2 2 0 0 1 2.5 .5Z";

/** The stub: the ticket right of the perforation. */
const ticketStub =
  "M18 2.2A2.25 2.25 0 0 0 20.2 .5H23.5A2 2 0 0 1 25.5 2.5V14.5A2 2 0 0 1 23.5 16.5H20.2A2.25 2.25 0 0 0 18 14.8Z";

const ticketColors = {
  light: { body: "#fae3c7", stub: "#edc49b", outline: "#c4926a" },
  dark: { body: "#fff5e9", stub: "#fae7d1", outline: undefined },
} as const;

/**
 * Miniature Entry pack ticket and Unlimited pass credential that identify the
 * two cowork pass products beside a link's text. Decorative: the link's own
 * text names the destination.
 */
export function PassProductMarks({
  surface = "light",
  className,
}: PassProductMarksProps) {
  const ticket = ticketColors[surface];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center gap-[0.23em]",
        className
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 26 17"
        className="h-[0.94em] w-[1.43em] overflow-visible"
        focusable="false"
      >
        <path d={ticketOutline} fill={ticket.body} />
        <path d={ticketStub} fill={ticket.stub} />
        <path
          d="M18 3.2V13.8"
          stroke="#aa643c"
          strokeWidth="1"
          strokeDasharray="1.6 1.2"
        />
        {ticket.outline && (
          <path d={ticketOutline} fill="none" stroke={ticket.outline} />
        )}
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 26 17"
        className="h-[0.94em] w-[1.43em] overflow-visible"
        focusable="false"
      >
        <rect
          x=".5"
          y=".5"
          width="25"
          height="16"
          rx="2.5"
          fill="#761730"
          stroke="#b06c7d"
        />
        <rect
          x="3.4"
          y="4.6"
          width="6.2"
          height="6.8"
          rx="1"
          fill="#f3b8c8"
          fillOpacity=".44"
        />
        <rect x="14.2" y="3" width="3" height="1.4" fill="#ffc2cc" />
        <rect x="17.2" y="3" width="3" height="1.4" fill="#d999bf" />
        <rect x="20.2" y="3" width="2.6" height="1.4" fill="#f3d9c6" />
      </svg>
    </span>
  );
}
