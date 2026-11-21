"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
  useId,
} from "react";
import { type Locale, m } from "@/features/i18n";
import { Tooltip } from "@/shared/components/ui/tooltip";
import { cn } from "@/shared/utils";

type FutureFeatureTooltipProps = {
  readonly children: ReactNode;
  readonly className?: string;
  readonly locale: Locale;
};

export function FutureFeatureTooltip({
  children,
  className,
  locale,
}: FutureFeatureTooltipProps) {
  const message = m.account_future_feature_tooltip({}, { locale });
  const contentId = useId();
  const childNodes = Children.toArray(children);
  const child = childNodes.length === 1 ? childNodes[0] : undefined;
  const elementChild = isValidElement<{ readonly id?: string }>(child)
    ? child
    : undefined;
  const existingChildId = elementChild?.props.id;
  const childId = existingChildId || contentId;
  const labelledChild =
    elementChild && !existingChildId
      ? cloneElement(elementChild, { id: contentId })
      : child;

  return (
    <Tooltip
      collisionPadding={16}
      contentClassName="w-[min(20rem,calc(100vw-2rem))] max-w-[320px] break-words whitespace-normal"
      trigger={
        // biome-ignore lint/a11y/useSemanticElements: A span preserves inline placement around disabled account controls.
        <span
          aria-labelledby={childId}
          className={cn(
            "inline-flex min-w-0 max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-burned-orange focus-visible:ring-offset-2",
            className
          )}
          role="group"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The group exposes a tooltip for a disabled child to keyboard users.
          tabIndex={0}
        >
          <span className="pointer-events-none contents">
            {labelledChild ?? children}
          </span>
        </span>
      }
    >
      {message}
    </Tooltip>
  );
}
