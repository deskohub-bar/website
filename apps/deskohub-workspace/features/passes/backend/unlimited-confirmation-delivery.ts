import { and, eq, exists, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { orders, passPurchases } from "@/db/schema";
import {
  DeliveryReportError,
  deliveryReportHandler,
  ignoredDeliveryReport,
  processedDeliveryReport,
} from "@/shared/backend/email/delivery-reports";
import { unlimitedConfirmationEmailKind } from "./unlimited-confirmation-email-kind";

export const unlimitedConfirmationDeliveryReports = deliveryReportHandler(
  unlimitedConfirmationEmailKind,
  ["email.delivered"],
  Effect.fnUntraced(function* (report) {
    if (Option.isNone(report.metadata))
      return ignoredDeliveryReport("metadata_missing");
    const { orderId, paymentAttemptId } = report.metadata.value;
    const { db } = yield* WorkspaceDatabase;
    const [recorded] = yield* db
      .update(passPurchases)
      .set({
        buyerConfirmationDeliveredAt: sql`least(${passPurchases.buyerConfirmationDeliveredAt}, ${report.occurredAt.toString()}::timestamptz)`,
      })
      .where(
        and(
          eq(passPurchases.id, orderId),
          eq(passPurchases.product, "unlimited"),
          exists(
            db
              .select({ id: orders.id })
              .from(orders)
              .where(
                and(
                  eq(orders.id, orderId),
                  eq(orders.kind, "pass-purchase"),
                  eq(orders.activePaymentAttemptId, paymentAttemptId),
                  eq(orders.paymentState, "paid")
                )
              )
          )
        )
      )
      .returning({ id: passPurchases.id })
      .pipe(
        Effect.mapError(
          () =>
            new DeliveryReportError({
              errorCode: "unlimited_confirmation_delivery_record_failed",
              message: "Could not record Unlimited pass confirmation delivery.",
            })
        )
      );
    return recorded
      ? processedDeliveryReport
      : ignoredDeliveryReport("purchase_not_current");
  })
);
