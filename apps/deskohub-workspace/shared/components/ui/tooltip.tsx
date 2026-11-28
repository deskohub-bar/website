"use client";

import { Tooltip as SharedTooltip } from "@deskohub/tooltip";
import type { ComponentProps } from "react";
import { cn } from "@/shared/utils";

export function Tooltip({
  collisionPadding = 0,
  contentClassName,
  ...props
}: ComponentProps<typeof SharedTooltip>) {
  return (
    <SharedTooltip
      {...props}
      collisionPadding={collisionPadding}
      contentClassName={cn(
        "z-50 overflow-hidden rounded-xl border border-navy-blue/12 bg-white px-3 py-2 text-sm text-navy-blue shadow-lg outline-none animate-in fade-in-0 zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--transform-origin)",
        contentClassName
      )}
    />
  );
}
