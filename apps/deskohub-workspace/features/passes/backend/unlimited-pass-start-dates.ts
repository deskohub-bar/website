import "server-only";

import { Effect } from "effect";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { getWorkspaceAvailabilityRange } from "@/features/reservation/workspace-availability";
import {
  currentInstant,
  type PlainDate,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import { findOwnedPassPurchaseOrder } from "./entry-pack-order";
import {
  getBookableUnlimitedStartMatrix,
  unlimitedStartRangeMaxDays,
} from "./unlimited-pass-capacity";

export const readUnlimitedPassStartDates = Effect.fn(
  "passes.readUnlimitedStartDates"
)(function* (input: {
  readonly startsOn?: PlainDate;
  readonly buyerAccountId?: CustomerAccountId;
  readonly predecessorOrderIds?: Iterable<OrderId>;
}) {
  const today = getCurrentWorkspaceDate(yield* currentInstant);
  const lastStartDate = Temporal.PlainDate.from(
    getWorkspaceAvailabilityRange(today.toString()).to
  );
  const requested = input.startsOn && Temporal.PlainDate.from(input.startsOn);
  const startsOn =
    requested && Temporal.PlainDate.compare(requested, today) > 0
      ? requested
      : today;
  if (Temporal.PlainDate.compare(startsOn, lastStartDate) > 0) {
    return { status: "unavailable" as const };
  }
  const rangeEnd = startsOn.add({ days: unlimitedStartRangeMaxDays });
  const endsBefore =
    Temporal.PlainDate.compare(rangeEnd, lastStartDate) > 0
      ? lastStartDate.add({ days: 1 })
      : rangeEnd;
  let supersedeOrderId: OrderId | undefined;
  if (input.buyerAccountId && input.predecessorOrderIds) {
    for (const predecessorOrderId of input.predecessorOrderIds) {
      const owned = yield* findOwnedPassPurchaseOrder(
        predecessorOrderId,
        input.buyerAccountId,
        "unlimited"
      );
      if (
        owned?.order.paymentState === "not_started" &&
        !owned.order.activePaymentAttemptId &&
        owned.purchase.status === "pending_payment"
      ) {
        supersedeOrderId = owned.order.id;
        break;
      }
    }
  }
  const matrix = yield* getBookableUnlimitedStartMatrix({
    startsOn,
    endsBefore,
    ...(supersedeOrderId && { supersedeOrderId }),
  });
  const toDates = (dates: readonly Temporal.PlainDate[]) =>
    dates.map((date) => plainDateStringSchema.make(date.toString()));
  const workstation = matrix["reserved-desk-workstation"];
  return {
    status: "ready" as const,
    today: plainDateStringSchema.make(today.toString()),
    lastStartDate: plainDateStringSchema.make(
      endsBefore.subtract({ days: 1 }).toString()
    ),
    starts: {
      "open-space": toDates(matrix["open-space"]),
      "reserved-desk": toDates(matrix["reserved-desk"]),
      "reserved-desk-workstation": {
        "2x27-qhd": toDates(workstation["2x27-qhd"]),
        "2x32-qhd": toDates(workstation["2x32-qhd"]),
        "2x27-4k": toDates(workstation["2x27-4k"]),
        "2x32-4k": toDates(workstation["2x32-4k"]),
      },
    },
  };
});
