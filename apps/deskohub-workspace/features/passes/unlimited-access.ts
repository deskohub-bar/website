import type { PlainDate } from "@/shared/utils/temporal";
import type { PassTier } from "./pass-offer";

export const unlimitedAccessTokenQueryParam = "passAccessToken";

type UnlimitedAccessPeriod = {
  readonly tier: PassTier;
  readonly validFrom: PlainDate;
  readonly validUntil: PlainDate;
};

type UnlimitedAccessDay = UnlimitedAccessPeriod & {
  readonly date: Temporal.PlainDate;
  readonly day: number;
  readonly continuesTomorrow: boolean;
};

export type UnlimitedAccessView =
  | (UnlimitedAccessPeriod & { readonly state: "before-start" | "ended" })
  | (UnlimitedAccessDay & { readonly state: "closed" | "retry" })
  | (UnlimitedAccessDay & {
      readonly state: "available";
      readonly code: string;
      readonly endsAt: Temporal.Instant;
      readonly deskLabel?: string;
    });
