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
import { passConfirmationEmailKinds } from "./pass-confirmation-email-kind";

const confirmationDeliveryReports = (
  product: keyof typeof passConfirmationEmailKinds,
  failure: { readonly errorCode: string; readonly message: string }
) =>
  deliveryReportHandler(
    passConfirmationEmailKinds[product],
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
            eq(passPurchases.product, product),
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
        .pipe(Effect.mapError(() => new DeliveryReportError(failure)));
      return recorded
        ? processedDeliveryReport
        : ignoredDeliveryReport("purchase_not_current");
    })
  );

export const entryPackConfirmationDeliveryReports = confirmationDeliveryReports(
  "entry-pack",
  {
    errorCode: "entry_pack_confirmation_delivery_record_failed",
    message: "Could not record Entry pack confirmation delivery.",
  }
);

export const unlimitedConfirmationDeliveryReports = confirmationDeliveryReports(
  "unlimited",
  {
    errorCode: "unlimited_confirmation_delivery_record_failed",
    message: "Could not record Unlimited pass confirmation delivery.",
  }
);
