import {
  getCanonicalWorkspaceProductIdentity,
  type WorkspaceProductIdentity,
} from "@/features/checkout/product-identity";
import type { CalculatedDiscountApplication } from "./calculator";
import type { AppliedDiscount, DiscountQuote } from "./contracts";
import type { DiscountClaimInstruction, DiscountProvenance } from "./provider";

interface DiscountCommitmentApplication {
  readonly application: AppliedDiscount;
  readonly provenance: DiscountProvenance;
  readonly claim?: DiscountClaimInstruction;
}

export const getAppliedPromotionDiscountId = (
  quote: DiscountQuote,
  applications: readonly Pick<
    DiscountCommitmentApplication,
    "application" | "claim"
  >[]
) =>
  applications.find(
    ({ application, claim }) =>
      (claim?.kind === "discount_code" || claim?.kind === "voucher") &&
      quote.discounts.some(
        ({ discount }) => discount.id === application.discount.id
      )
  )?.application.discount.id;

export interface DiscountCommitmentPayload {
  readonly product: WorkspaceProductIdentity;
  /** Prague start date of the reservation the discounts were affirmed for. */
  readonly firstServiceDate: string;
  readonly applications: readonly DiscountCommitmentApplication[];
}

const readDiscountCommitment = Symbol("readDiscountCommitment");

class DiscountCommitmentValue {
  readonly #payload: DiscountCommitmentPayload;

  constructor(payload: DiscountCommitmentPayload) {
    this.#payload = payload;
  }

  [readDiscountCommitment]() {
    return this.#payload;
  }
}

export type DiscountCommitment = DiscountCommitmentValue;

export const makeDiscountCommitment = (input: {
  readonly product: WorkspaceProductIdentity;
  readonly firstServiceDate: string;
  readonly applications: readonly CalculatedDiscountApplication[];
}): DiscountCommitment => {
  return new DiscountCommitmentValue({
    product: getCanonicalWorkspaceProductIdentity(input.product),
    firstServiceDate: input.firstServiceDate,
    applications: input.applications.map(({ application, candidate }) => ({
      application,
      provenance: candidate.provenance,
      ...(candidate.claim !== undefined && { claim: candidate.claim }),
    })),
  });
};

export const getDiscountCommitmentPayload = (
  commitment: DiscountCommitment
): DiscountCommitmentPayload => commitment[readDiscountCommitment]();
