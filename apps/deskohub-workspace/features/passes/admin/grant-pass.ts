import { Effect, Schema } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import { findPurchaseLoginEmail } from "@/features/account/backend/customer-account-by-email";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import type { Locale } from "@/features/i18n";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";
import { currencyCZK } from "@/shared/money/currencies";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import { queueInitialEntryPackGift } from "../backend/entry-pack-gift";
import { withUnlimitedPassCapacity } from "../backend/unlimited-pass-capacity";
import { recordUnlimitedPassOrder } from "../backend/unlimited-pass-orders";
import { resolvePassHolderCustomer } from "../backend/unlimited-pass-purchase";
import { getEntryPackValidity } from "../pass-offer";
import { passPurchaseQuoteCodec } from "../pass-purchase-quote";
import type { PassChangeRequest } from "./pass-change";
import {
  insertPassChange,
  PassChangeRefused,
  readPassChangeReplay,
} from "./pass-change-records";

type GrantRequest = PassChangeRequest & {
  readonly change: Extract<PassChangeRequest["change"], { _tag: "grant" }>;
};

export const grantPass = Effect.fn("grantPass")(function* (
  input: GrantRequest,
  locale: Locale,
  recipientName?: string
) {
  const actor = yield* CurrentAdministrator;
  const { transaction } = yield* WorkspaceDatabase;

  return yield* Effect.gen(function* () {
    const existing = yield* transaction(
      readPassChangeReplay(input, actor.accountId)
    );
    if (existing) return existing;
    const { holderAccountId, selection } = input.change;
    const now = yield* currentInstant;
    const today = getWorkspaceDate(now).toString();
    if (
      !("kind" in selection) &&
      (selection.startDate < today ||
        selection.startDate > getWorkspaceAvailabilityRange(today).to)
    )
      return yield* new PassChangeRefused({ reason: "invalid-validity" });

    const email = yield* findPurchaseLoginEmail(holderAccountId);
    if (!email)
      return yield* new PassChangeRefused({ reason: "holder-unavailable" });
    const customerId = yield* resolvePassHolderCustomer({
      accountId: holderAccountId,
      email,
      recipientName,
    }).pipe(WorkspaceLockSections.unlimitedGiftCustomer(holderAccountId));

    const zero = currencyCZK(0);
    const quote = {
      product:
        "kind" in selection
          ? selection
          : { kind: "unlimited" as const, tier: selection.tier },
      discountableSubtotal: zero,
      discounts: [],
      totalDiscount: zero,
      discountedSubtotal: zero,
    };
    if (!("kind" in selection)) {
      return yield* withUnlimitedPassCapacity(
        {
          selection,
          startDate: Temporal.PlainDate.from(selection.startDate),
        },
        (plan) =>
          transaction(
            Effect.gen(function* () {
              yield* recordUnlimitedPassOrder({
                orderId: input.passId,
                buyer: { accountId: actor.accountId, customerId },
                holder: { accountId: holderAccountId, customerId },
                createdAt: now,
                complimentary: true,
                locale,
                quote,
                selection,
                days: plan.days.map(({ serviceDate, tableId }) => ({
                  serviceDate: plainDateStringSchema.make(
                    serviceDate.toString()
                  ),
                  tableId,
                })),
              });
              return yield* insertPassChange(input, actor, now, "pending");
            })
          ).pipe(WorkspaceLockSections.passPurchaseFulfillment(input.passId))
      );
    }

    return yield* transaction(
      Effect.gen(function* () {
        const { db } = yield* WorkspaceTransaction;
        yield* db.insert(orders).values({
          id: input.passId,
          kind: "pass-purchase",
          dotyposCustomerId: customerId,
          paymentState: "complimentary",
          fulfillmentState: "fulfilled",
          fulfilledAt: now,
        });
        const [purchase] = yield* db
          .insert(passPurchases)
          .values({
            id: input.passId,
            buyerAccountId: actor.accountId,
            holderAccountId,
            product: "entry-pack",
            tier: selection.tier,
            entryCount: selection.size,
            status: "active",
            giftIssuedAt: actor.accountId === holderAccountId ? null : now,
            ...getEntryPackValidity(now, selection.size),
            quote: yield* Schema.encodeEffect(passPurchaseQuoteCodec)(quote),
            locale,
            createdAt: now,
          })
          .returning();
        if (!purchase)
          return yield* new PassChangeRefused({ reason: "changed" });
        yield* queueInitialEntryPackGift(purchase, now);
        return yield* insertPassChange(input, actor, now, "completed");
      })
    ).pipe(WorkspaceLockSections.passPurchaseFulfillment(input.passId));
  }).pipe(WorkspaceLockSections.unlimitedPassRecovery(input.passId));
});
