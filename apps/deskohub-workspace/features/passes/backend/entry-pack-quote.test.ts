import { expect, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { calculateDiscounts } from "@/features/discounts/calculator";
import {
  type DiscountQuoteInput,
  discountIdSchema,
} from "@/features/discounts/contracts";
import { DiscountService } from "@/features/discounts/discount.service";
import { currencyCZK } from "@/shared/money/currencies";
import { quoteEntryPack } from "./entry-pack-quote";

test("quotes a pack on its Prague purchase date with the buyer's discount", async () => {
  const buyer = DotyposCustomerIdSchema.make("test-buyer");
  const purchasedAt = Temporal.Instant.from("2026-11-18T23:30:00Z");
  const product = { kind: "entry-pack", tier: "open-space", size: 5 } as const;
  let received: DiscountQuoteInput | undefined;
  const result = await Effect.runPromise(
    quoteEntryPack({ buyer, purchasedAt, product, locale: "en-US" }).pipe(
      Effect.provide(
        Layer.mock(DiscountService, {
          quote: (input) => {
            received = input;
            return calculateDiscounts({
              ...input,
              candidates: [
                {
                  provenance: {
                    providerNamespace: "dotypos-customer-discount",
                    providerReference: "fixture",
                  },
                  discount: {
                    id: discountIdSchema.make("buyer-discount"),
                    label: "Buyer discount",
                    adjustment: { kind: "percentage", basisPoints: 1500 },
                  },
                },
              ],
            }).pipe(Effect.map(({ quote }) => quote));
          },
        })
      )
    )
  );

  expect(received).toMatchObject({
    product,
    firstServiceDate: "2026-11-19",
    lastServiceDate: "2026-11-19",
    dotyposCustomerId: buyer,
    bookedAt: purchasedAt,
    discountableSubtotal: currencyCZK(115_000),
  });
  expect(result.quote.discountedSubtotal).toEqual(currencyCZK(97_750));
  expect(result.validUntil).toBe("2027-01-19");
});
