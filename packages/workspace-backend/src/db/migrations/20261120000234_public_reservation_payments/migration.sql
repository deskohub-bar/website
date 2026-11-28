CREATE SEQUENCE "public"."qr_payment_references" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9999999999 START WITH 1000000000 CACHE 1;--> statement-breakpoint
CREATE TABLE "reservation_payment_windows" (
	"order_id" text PRIMARY KEY,
	"account_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"card_attempt_id" text,
	"qr_attempt_id" text
);
--> statement-breakpoint
CREATE TABLE "fio_account_polls" (
	"account_key" text PRIMARY KEY,
	"first_demand_date" date NOT NULL,
	"covered_through" date,
	"delivery_id" uuid,
	"delivery_expires_at" timestamp with time zone,
	"read_id" uuid,
	"read_not_before" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fio_payment_settlements" (
	"id" text PRIMARY KEY DEFAULT uuid_generate_v7(),
	"order_id" text,
	"payment_attempt_id" text,
	"account_key" text NOT NULL,
	"movement_id" text NOT NULL,
	"variable_symbol" text,
	"amount_value" bigint,
	"currency" text NOT NULL,
	"decimal_amount" text,
	"booking_date" date NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"disposition" text NOT NULL,
	"discrepancy_reason" text,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "fio_payment_settlements_disposition_check" CHECK ("disposition" in ('discrepancy', 'winner', 'recovery_pending', 'review_required', 'refund_required', 'refunded')),
	CONSTRAINT "fio_payment_settlements_amount_check" CHECK (("currency" = 'CZK' and "amount_value" is not null and "decimal_amount" is null)
        or ("currency" <> 'CZK' and "amount_value" is null and "decimal_amount" is not null)),
	CONSTRAINT "fio_payment_settlements_discrepancy_check" CHECK (("disposition" = 'discrepancy') = ("discrepancy_reason" is not null)
        and "discrepancy_reason" in ('reference_absent', 'reference_invalid', 'reference_unmatched', 'non_credit', 'amount_mismatch', 'currency_mismatch')),
	CONSTRAINT "fio_payment_settlements_reference_check" CHECK (("order_id" is null) = ("payment_attempt_id" is null)
        and ("disposition" = 'discrepancy' or "order_id" is not null)
        and ("order_id" is null or "variable_symbol" is not null)),
	CONSTRAINT "fio_payment_settlements_refund_check" CHECK (("disposition" = 'refunded') = ("refunded_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fio_payment_settlements_movement_idx" ON "fio_payment_settlements" ("account_key","movement_id");--> statement-breakpoint
CREATE INDEX "fio_payment_settlements_account_idx" ON "fio_payment_settlements" ("account_key","id");--> statement-breakpoint
CREATE INDEX "fio_payment_settlements_order_idx" ON "fio_payment_settlements" ("order_id","id");--> statement-breakpoint
CREATE INDEX "fio_payment_settlements_attempt_idx" ON "fio_payment_settlements" ("payment_attempt_id");--> statement-breakpoint
ALTER TABLE "reservation_payment_windows" ADD CONSTRAINT "reservation_payment_windows_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reservation_payment_windows" ADD CONSTRAINT "reservation_payment_windows_aEN0w29ITTVq_fkey" FOREIGN KEY ("card_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reservation_payment_windows" ADD CONSTRAINT "reservation_payment_windows_puW1f6oUSfOx_fkey" FOREIGN KEY ("qr_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "fio_payment_settlements" ADD CONSTRAINT "fio_payment_settlements_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "fio_payment_settlements" ADD CONSTRAINT "fio_payment_settlements_L9BQt2FiLbKV_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id");--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_provider_check", ADD CONSTRAINT "payment_attempts_provider_check" CHECK ("provider" in ('nexi', 'mock', 'fio', 'internal'));--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_refund_state_check", ADD CONSTRAINT "payment_attempts_refund_state_check" CHECK ("refund_state" in ('not_required', 'required', 'refunded') and ("refund_state" = 'not_required' or ("provider" in ('nexi', 'mock', 'fio') and "state" = 'paid')));--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_amount_check", ADD CONSTRAINT "payment_attempts_amount_check" CHECK (("provider" in ('nexi', 'mock', 'fio') and "amount_value" > 0) or ("provider" = 'internal' and "amount_value" = 0));--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_provider_fields_check", ADD CONSTRAINT "payment_attempts_provider_fields_check" CHECK (("provider" in ('nexi', 'mock', 'fio') and "provider_order_id" is not null) or ("provider" = 'internal' and "provider_order_id" is null and "security_token" is null and "provider_redirect_url" is null and "last_webhook_event_id" is null and "last_provider_operation_id" is null and "last_provider_status" is null and "provider_order_created_at" is null));