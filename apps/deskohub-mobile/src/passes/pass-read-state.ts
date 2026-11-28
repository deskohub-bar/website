import type {
  CustomerPassBookingOptions,
  CustomerPassList,
  CustomerPassTier,
} from "@deskohub/workspace-customer-api";
import { Cause, Option, Predicate } from "effect";
import { AsyncResult } from "effect/reactivity";

export const passFeatureClosed = (
  read: AsyncResult.AsyncResult<unknown, unknown>
) =>
  AsyncResult.isFailure(read) &&
  Option.exists(
    Cause.findErrorOption(read.cause),
    Predicate.isTagged("CustomerPassesUnavailable")
  );

type CashBookingCoverage = "clear" | "checking" | "unknown" | "covered";

export function cashBookingCoverage(
  catalog: AsyncResult.AsyncResult<unknown, unknown>,
  held: AsyncResult.AsyncResult<CustomerPassList, unknown>,
  options: AsyncResult.AsyncResult<CustomerPassBookingOptions, unknown>,
  tier: CustomerPassTier
): CashBookingCoverage {
  if (passFeatureClosed(catalog) || passFeatureClosed(held)) return "clear";
  if (AsyncResult.isInitial(held) || held.waiting) return "checking";
  if (AsyncResult.isFailure(held)) return "unknown";
  if (
    !held.value.held.some(
      (pass) =>
        pass.kind === "unlimited" &&
        (pass.status === "active" || pass.status === "upcoming")
    )
  )
    return "clear";
  if (passFeatureClosed(options)) return "clear";
  if (AsyncResult.isInitial(options) || options.waiting) return "checking";
  if (AsyncResult.isFailure(options)) return "unknown";
  return options.value.unlimited?.tier === tier ? "covered" : "clear";
}
