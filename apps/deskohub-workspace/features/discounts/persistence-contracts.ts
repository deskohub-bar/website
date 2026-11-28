export {
  type DiscountApplicationId,
  type DiscountCodeClaimId,
  type DiscountCodeId,
  discountApplicationIdSchema,
  discountCodeClaimIdSchema,
  discountCodeIdSchema,
  type PromotionCodeId,
  promotionCodeIdSchema,
  type StoredDiscountId,
  storedDiscountIdSchema,
  type VoucherClaimId,
  type VoucherId,
  voucherClaimIdSchema,
  voucherIdSchema,
} from "@deskohub/workspace-domain/features/discounts/persistence-contracts";

export {
  type CanonicalPromotionCode,
  canonicalPromotionCodeSchema,
} from "./contracts";
