import "server-only";

import { Effect, Layer } from "effect";
import { cache } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerProfileService } from "@/features/account/backend/customer-profile.service";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import {
  type EntryPackGiftState,
  recoverEntryPackGiftClaims,
} from "@/features/passes/backend/entry-pack-gift";
import {
  getHeldEntryPackStatus,
  type HeldEntryPack,
  listHeldEntryPacks,
} from "@/features/passes/backend/held-entry-packs";
import {
  readBoughtPassGifts,
  readHeldPassGiftBuyers,
} from "@/features/passes/backend/pass-gift-reads";
import {
  type EntryPackSize,
  getEntryPackLastUsableDate,
} from "@/features/passes/pass-offer";
import { getPassTierName } from "@/features/passes/pass-offer.i18n";
import {
  getEntryPackBookingPath,
  getPassPurchaseStatusPath,
} from "@/features/passes/routes";
import { runWorkspaceEffectOrElse } from "@/shared/backend/workspace-effect";
import {
  formatInstantDate,
  formatPlainDate,
} from "@/shared/utils/date-time-format";
import { workspaceSiteConstants } from "@/shared/utils/site-constants";
import { currentPlainDate, type PlainDate } from "@/shared/utils/temporal";

export type AccountEntryPack = {
  readonly position: number;
  readonly tier: string;
  readonly entryCount: number;
  readonly entriesLeft: number;
  readonly boughtOn?: string;
  readonly lastUsableDay: string;
  readonly status: "active" | "expired" | "depleted" | "ended";
  readonly bookPath?: string;
  readonly statusPath?: string;
  readonly gift?: {
    readonly orderId: OrderId;
    readonly buyerName?: string;
  };
};

export type AccountBoughtPass = Omit<EntryPackGiftState, "canResend"> & {
  readonly orderId: OrderId;
  readonly statusPath: string;
  readonly tier: string;
  readonly maskedHolderEmail?: string;
} & (
    | {
        readonly product: "entry-pack";
        readonly entryCount: EntryPackSize;
        readonly canResend: boolean;
      }
    | { readonly product: "unlimited" }
  );

export type AccountPasses =
  | {
      readonly held: readonly AccountEntryPack[];
      readonly boughtForOthers: readonly AccountBoughtPass[];
    }
  | "unavailable";

const timeZone = workspaceSiteConstants.location.timeZone;

export const loadAccountPasses = Effect.fn("loadAccountPasses")(function* (
  locale: Locale,
  profileLayer: Layer.Layer<
    CustomerProfileService,
    unknown
  > = CustomerProfileService.Live
) {
  const account = yield* CurrentCustomerAccount;
  const standing = yield* account.peek;
  if (standing.kind === "review")
    return { held: [], boughtForOthers: [] } as const;
  if (
    (standing.kind !== "linked" && standing.kind !== "unlinked") ||
    standing.reviewMarker !== "absent"
  ) {
    return "unavailable" as const;
  }

  const { accountId, verifiedSignInAt } = standing.session;
  yield* recoverEntryPackGiftClaims(accountId, verifiedSignInAt);
  const [packs, today, boughtForOthers] = yield* Effect.all(
    [
      listHeldEntryPacks(accountId),
      currentPlainDate(timeZone),
      listBoughtGifts(accountId, locale),
    ],
    { concurrency: "unbounded" }
  );
  const giftBuyers = yield* readHeldPassGiftBuyers(
    accountId,
    packs.map(({ id }) => id),
    profileLayer
  );
  return {
    held: packs.map((pack, position) => ({
      ...toAccountEntryPack(pack, position, today, locale),
      gift: giftBuyers.has(pack.id)
        ? { orderId: pack.id, buyerName: giftBuyers.get(pack.id) }
        : undefined,
    })),
    boughtForOthers,
  };
});

const listBoughtGifts = Effect.fn("listBoughtPassGifts")(function* (
  accountId: CustomerAccountId,
  locale: Locale
) {
  const gifts = yield* readBoughtPassGifts(accountId);
  return gifts.map(
    ({ orderId, product, canResend, ...gift }): AccountBoughtPass => {
      const summary = {
        ...gift,
        orderId,
        statusPath: getPassPurchaseStatusPath(locale, orderId),
        tier: getPassTierName(product.tier, locale),
      };
      return product.kind === "unlimited"
        ? { ...summary, product: "unlimited" }
        : {
            ...summary,
            product: "entry-pack",
            entryCount: product.size,
            canResend,
          };
    }
  );
});

export const loadCustomerAccountPasses = cache(
  (locale: Locale): Promise<AccountPasses> =>
    loadAccountPasses(locale).pipe(
      Effect.provide(
        Layer.mergeAll(CurrentCustomerAccount.Live, WorkspaceDatabase.Default)
      ),
      runWorkspaceEffectOrElse("account.passes", {
        boundary: "page",
        failureCode: "account.passes.unavailable",
        orElse: () => "unavailable" as const,
      })
    )
);

function toAccountEntryPack(
  pack: HeldEntryPack,
  position: number,
  today: PlainDate,
  locale: Locale
): AccountEntryPack {
  const status = getHeldEntryPackStatus(pack, today);

  return {
    position,
    tier: getPassTierName(pack.tier, locale),
    entryCount: pack.entryCount,
    entriesLeft: pack.entriesLeft,
    ...(!pack.complimentary && {
      boughtOn: formatInstantDate({ instant: pack.paidAt, locale, timeZone }),
    }),
    lastUsableDay: formatPlainDate({
      date: getEntryPackLastUsableDate(pack.validUntil),
      locale,
    }),
    status,
    ...(status === "active" &&
      pack.entriesLeft > 0 &&
      (pack.giftIssuedAt === null || pack.giftClaimedAt !== null) &&
      pack.giftPaymentIsUsable && {
        bookPath: getEntryPackBookingPath(locale, pack.id),
      }),
    ...(pack.canViewOrderStatus && {
      statusPath: getPassPurchaseStatusPath(locale, pack.id),
    }),
  };
}
