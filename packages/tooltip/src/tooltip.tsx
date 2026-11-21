"use client";

import { sourceOf } from "@ui-sdk/core";
import { renderElement } from "@ui-sdk/react/primitive";
import {
  createTooltipController,
  TooltipContent,
  type TooltipContentProps,
  Tooltip as TooltipPrimitive,
  type TooltipProps,
  TooltipTrigger,
} from "@ui-sdk/react/tooltip";
import {
  type MouseEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type Props = Pick<
  TooltipProps,
  "children" | "defaultOpen" | "delay" | "onOpenChange" | "open"
> &
  Pick<TooltipContentProps, "align" | "collisionPadding" | "side"> & {
    trigger: ReactElement;
    contentClassName?: string;
  };

export function Tooltip({
  align,
  children,
  collisionPadding,
  contentClassName,
  delay = 200,
  side,
  trigger,
  ...props
}: Props) {
  const [controller] = useState(createTooltipController);
  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const setTrigger = useCallback((element: HTMLElement | null) => {
    triggerRef.current = element;
  }, []);

  useEffect(() => {
    const document = triggerRef.current?.ownerDocument;
    if (!document) return;

    function dismissOnScroll(event: Event) {
      if (
        event.target instanceof Node &&
        event.target.contains(triggerRef.current)
      ) {
        controller.close();
      }
    }

    const dismissOnOutsideTouch = (event: PointerEvent) => {
      if (
        event.pointerType === "touch" &&
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !contentRef.current?.contains(event.target)
      ) {
        controller.close({ reason: "outside-press", event });
      }
    };

    const cleanup = new AbortController();
    const options = { capture: true, passive: true, signal: cleanup.signal };
    document.addEventListener("scroll", dismissOnScroll, options);
    // WebKit may omit the click the SDK waits for on non-interactive targets.
    document.addEventListener("pointerup", dismissOnOutsideTouch, options);
    return () => cleanup.abort();
  }, [controller]);

  return (
    <TooltipPrimitive
      {...props}
      controller={controller}
      delay={delay}
      type="description"
    >
      <TooltipTrigger
        ref={setTrigger}
        render={(triggerProps) =>
          renderElement(
            "button",
            {
              ...triggerProps,
              onClick: (event: MouseEvent<HTMLElement>) => {
                if (sourceOf(event.nativeEvent) !== "touch") {
                  triggerProps.onClick?.(event);
                  return;
                }

                // Bypass the SDK's press handler for touch. Canceling the click
                // would also cancel actions on composed controls and submits.
                controller.toggle({
                  reason: "trigger-press",
                  event: event.nativeEvent,
                });
              },
            },
            trigger
          )
        }
      />
      <TooltipContent
        align={align}
        className={contentClassName}
        collisionPadding={collisionPadding}
        ref={contentRef}
        side={side}
      >
        {children}
      </TooltipContent>
    </TooltipPrimitive>
  );
}
