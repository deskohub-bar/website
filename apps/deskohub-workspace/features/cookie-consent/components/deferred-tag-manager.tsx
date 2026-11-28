"use client";

import { useEffect } from "react";
import { isEntryPackGiftSignInDocument } from "@/features/passes/entry-pack-gift-sign-in.browser";
import { scheduleTagManagerLoad } from "../utils/tag-manager";

type DeferredTagManagerProps = {
  gtmId: string;
};

export function DeferredTagManager({ gtmId }: DeferredTagManagerProps) {
  useEffect(() => {
    if (!isEntryPackGiftSignInDocument()) return scheduleTagManagerLoad(gtmId);
  }, [gtmId]);

  return null;
}
