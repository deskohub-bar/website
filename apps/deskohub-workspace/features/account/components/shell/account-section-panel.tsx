import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/shared/utils";

/*
 * Shared section chrome for the account screens: one white inset card with a
 * titled header, a divider, a body, and an optional sticky safe-area footer.
 * Every account section renders through this panel so spacing, typography,
 * and overflow behavior cannot drift apart.
 */

export interface AccountSectionPanelProps
  extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  readonly title: ReactNode;
  /** Heading id for `aria-labelledby`; generated when omitted. */
  readonly titleId?: string;
  /** Content rendered on the trailing side of the header row. */
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  /**
   * `inset` sets the footer inside the panel padding below a divider, as form
   * actions sit; `edge-to-edge` spans the panel's full width and bottom edge
   * and leaves its chrome to the footer content.
   */
  readonly footerLayout?: "inset" | "edge-to-edge";
  /** Classes for the body below the header, such as centering its content. */
  readonly bodyClassName?: string;
  readonly variant?: "default" | "destructive";
  /** `compact` sets a smaller title and tighter header for dense dashboards. */
  readonly size?: "default" | "compact";
}

export function AccountSectionPanel({
  actions,
  bodyClassName,
  children,
  className,
  footer,
  footerLayout = "inset",
  size = "default",
  title,
  titleId,
  variant = "default",
  ...rest
}: AccountSectionPanelProps) {
  const generatedTitleId = useId();
  const headingId = titleId ?? generatedTitleId;
  const tone = {
    default: {
      border: "border-[#dfe4ec]",
      divider: "border-[#e6ebf1]",
      title: "text-[#00024f]",
    },
    destructive: {
      border: "border-rose-200",
      divider: "border-rose-200",
      title: "text-rose-900",
    },
  }[variant];
  const density = {
    default: {
      section: undefined,
      header: "items-start pb-5",
      title: "text-[26px] tracking-[-0.025em]",
      body: "pt-7",
    },
    compact: {
      section: "pb-4 @xl:pb-5",
      header: "items-center pb-4",
      title: "text-xl tracking-[-0.02em]",
      body: "pt-4 @xl:pt-8",
    },
  }[size];

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "min-w-0 rounded-2xl border bg-white p-5 text-navy-blue shadow-[0_18px_40px_-28px_rgba(0,2,79,0.45)] @xl:p-8 [&_input]:scroll-mb-[calc(12rem+env(safe-area-inset-bottom))] [&_select]:scroll-mb-[calc(12rem+env(safe-area-inset-bottom))]",
        tone.border,
        density.section,
        // An edge-to-edge footer with content takes the bottom padding's place,
        // since a negative margin would push a docked sticky footer off
        // screen. Clipping keeps it inside the rounded corners without
        // creating a scroll container, so it stays sticky.
        footer !== undefined &&
          footerLayout === "edge-to-edge" &&
          "has-[>[data-footer-layout=edge-to-edge]>:not(template)]:overflow-clip has-[>[data-footer-layout=edge-to-edge]>:not(template)]:pb-0!",
        className
      )}
      {...rest}
      data-slot="account-section-panel"
      data-size={size}
      data-variant={variant}
    >
      <header
        className={cn(
          "flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-3 border-b",
          density.header,
          tone.divider
        )}
      >
        <h2
          className={cn(
            "min-w-0 break-words font-bold leading-tight",
            density.title,
            tone.title
          )}
          id={headingId}
        >
          {title}
        </h2>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>

      <div className={cn("min-w-0", density.body, bodyClassName)}>
        {children}
      </div>

      {footer !== undefined && (
        <div
          className={cn(
            "sticky z-10 min-w-0",
            {
              inset: cn(
                "bottom-[var(--install-bar-space,0px)] mt-8 border-t bg-white pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
                tone.divider
              ),
              // Docks above the install bar or the safe area, whichever is
              // taller, since its tint would otherwise fill the safe area. A
              // footer that renders nothing, or is still streaming in (React
              // holds its place with a `template`), leaves the panel as is.
              "edge-to-edge":
                "bottom-[max(var(--install-bar-space,0px),env(safe-area-inset-bottom))] mt-[18px] -mx-5 not-has-[>:not(template)]:hidden @xl:-mx-8",
            }[footerLayout]
          )}
          data-footer-layout={footerLayout}
        >
          {footer}
        </div>
      )}
    </section>
  );
}
