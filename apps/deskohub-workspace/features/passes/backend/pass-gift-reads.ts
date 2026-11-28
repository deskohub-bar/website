import "server-only";

import { getCustomerDisplayName } from "@deskohub/dotypos";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import { findEntryPackPurchasePartyContacts } from "@/features/account/backend/customer-account-by-email";
import { CustomerProfileService } from "@/features/account/backend/customer-profile.service";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import { catchRecoverableCause } from "@/shared/backend/workspace-effect";
import { maskEmailAddress } from "@/shared/utils";
import type { EntryPackProduct, UnlimitedPassProduct } from "../pass-offer";
import {
  type EntryPackGiftState,
  readEntryPackGiftStates,
} from "./entry-pack-gift";

type BoughtPassGift = EntryPackGiftState & {
  readonly orderId: OrderId;
  readonly product: EntryPackProduct | UnlimitedPassProduct;
  readonly maskedHolderEmail?: string;
};

export const readBoughtPassGifts = Effect.fn("readBoughtPassGifts")(function* (
  accountId: CustomerAccountId
) {
  const { db } = yield* WorkspaceDatabase;
  const gifts = yield* db
    .select({
      orderId: passPurchases.id,
      holderAccountId: passPurchases.holderAccountId,
      tier: passPurchases.tier,
      product: passPurchases.product,
      entryCount: passPurchases.entryCount,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .where(
      and(
        eq(passPurchases.buyerAccountId, accountId),
        ne(passPurchases.holderAccountId, accountId),
        eq(orders.kind, "pass-purchase"),
        eq(orders.paymentState, "paid"),
        isNotNull(orders.paidAt)
      )
    )
    .orderBy(desc(orders.paidAt), desc(passPurchases.id));
  if (gifts.length === 0) return [];

  const recipientIds = [...new Set(gifts.map((gift) => gift.holderAccountId))];
  const [states, recipients] = yield* Effect.all(
    [
      readEntryPackGiftStates(gifts.map((gift) => gift.orderId)),
      findEntryPackPurchasePartyContacts(recipientIds),
    ],
    { concurrency: "unbounded" }
  );
  const result: BoughtPassGift[] = [];
  for (const { orderId, tier, product, entryCount, holderAccountId } of gifts) {
    const state = states.get(orderId);
    // A refund can end payment eligibility between the two reads.
    if (!state) continue;
    const email = recipients.get(holderAccountId)?.email;
    const masked = email ? maskEmailAddress(email) : undefined;
    const maskedHolderEmail = masked === email ? undefined : masked;
    const summary = {
      ...state,
      orderId,
      maskedHolderEmail,
      canResend: state.canResend && maskedHolderEmail !== undefined,
    };
    if (product === "unlimited")
      result.push({ ...summary, product: { kind: product, tier } });
    else if (entryCount !== null)
      result.push({
        ...summary,
        product: { kind: product, tier, size: entryCount },
      });
  }
  return result;
});

export const readHeldPassGiftBuyers = Effect.fn("readHeldPassGiftBuyers")(
  function* (
    holderAccountId: CustomerAccountId,
    heldIds: readonly OrderId[],
    profileLayer: Layer.Layer<
      CustomerProfileService,
      unknown
    > = CustomerProfileService.Live
  ) {
    if (heldIds.length === 0) return new Map<OrderId, string | undefined>();
    const { db } = yield* WorkspaceDatabase;
    const gifts = yield* db
      .select({
        orderId: passPurchases.id,
        accountId: passPurchases.buyerAccountId,
      })
      .from(passPurchases)
      .innerJoin(orders, eq(orders.id, passPurchases.id))
      .where(
        and(
          eq(passPurchases.holderAccountId, holderAccountId),
          eq(orders.paymentState, "paid"),
          ne(passPurchases.buyerAccountId, holderAccountId),
          inArray(passPurchases.id, heldIds)
        )
      );
    const buyers = yield* findEntryPackPurchasePartyContacts(
      gifts.map((gift) => gift.accountId)
    );
    const linkedBuyers = [...buyers].flatMap(
      ([accountId, { dotyposCustomerId }]) =>
        dotyposCustomerId ? [{ accountId, dotyposCustomerId }] : []
    );
    const profileNames = new Map(
      linkedBuyers.length === 0
        ? []
        : yield* Effect.gen(function* () {
            const profiles = yield* CustomerProfileService;
            return yield* Effect.forEach(
              linkedBuyers,
              (buyer) =>
                profiles.load(buyer).pipe(
                  Effect.map(({ firstName, lastName }) => {
                    const name = getCustomerDisplayName({
                      firstName,
                      lastName,
                    });
                    return name?.includes("@") ? undefined : name;
                  }),
                  catchRecoverableCause(() => Effect.succeed(undefined)),
                  Effect.map((name) => [buyer.accountId, name] as const)
                ),
              { concurrency: 4 }
            );
          }).pipe(
            Effect.provide(profileLayer),
            catchRecoverableCause(() => Effect.succeed([]))
          )
    );
    return new Map(
      gifts.map(({ orderId, accountId }) => [
        orderId,
        profileNames.get(accountId),
      ])
    );
  }
);
