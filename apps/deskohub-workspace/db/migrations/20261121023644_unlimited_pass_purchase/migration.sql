SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "unlimited_pass_supersessions" (
	"buyer_account_id" text,
	"order_id" uuid,
	CONSTRAINT "unlimited_pass_supersessions_pkey" PRIMARY KEY("buyer_account_id","order_id")
);
--> statement-breakpoint
ALTER TABLE "pass_purchases" DROP CONSTRAINT "pass_purchases_entry_count_check";--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "unlimited_coffee" boolean;--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "unlimited_monitor_option" text;--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "holds_expire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "access_ends_on" date;--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "buyer_confirmation_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD COLUMN "pass_id" text;--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD COLUMN "service_date" date;--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD COLUMN "pass_day_table_id" text;--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD COLUMN "pass_day_hold_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD COLUMN "pass_day_hold_generation" uuid;--> statement-breakpoint
ALTER TABLE "pass_purchases" ALTER COLUMN "entry_count" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_reservations_pass_date_idx" ON "workspace_reservations" ("pass_id","service_date") WHERE "pass_id" is not null;--> statement-breakpoint
ALTER TABLE "unlimited_pass_supersessions" ADD CONSTRAINT "unlimited_pass_supersessions_jQBu0VWIqPPM_fkey" FOREIGN KEY ("buyer_account_id") REFERENCES "customer_accounts"("id");--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD CONSTRAINT "workspace_reservations_pass_id_pass_purchases_id_fkey" FOREIGN KEY ("pass_id") REFERENCES "pass_purchases"("id");--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD CONSTRAINT "pass_purchases_monitor_option_check" CHECK ("unlimited_monitor_option" in ('2x27-qhd', '2x32-qhd', '2x27-4k', '2x32-4k'));--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD CONSTRAINT "workspace_reservations_pass_day_check" CHECK (("pass_id" is null and "service_date" is null and "pass_day_table_id" is null
          and "pass_day_hold_requested_at" is null and "pass_day_hold_generation" is null)
        or ("pass_id" is not null and "service_date" is not null and "pass_day_table_id" is not null
          and "active_payment_attempt_id" is null and "active_customer_email_delivery_id" is null));--> statement-breakpoint
ALTER TABLE "contract_withdrawals" DROP CONSTRAINT "contract_withdrawals_refund_basis_check", ADD CONSTRAINT "contract_withdrawals_refund_basis_check" CHECK (("refund_unit" is null and "refund_unstarted_units" is null and "refund_total_units" is null and "refund_amount_value" = "paid_amount_value") or ("refund_unit" in ('day', 'hour') and ("refund_unstarted_units" > 0 or ("contract_kind" = 'unlimited-pass' and "refund_unit" = 'day' and "refund_unstarted_units" = 0 and "refund_amount_value" = 0)) and "refund_total_units" > "refund_unstarted_units"));--> statement-breakpoint
ALTER TABLE "pass_purchases" DROP CONSTRAINT "pass_purchases_product_check", ADD CONSTRAINT "pass_purchases_product_check" CHECK (("product" = 'entry-pack' and "entry_count" is not null
          and "entry_count" in (5, 10)
          and "unlimited_coffee" is null and "unlimited_monitor_option" is null
          and "holds_expire_at" is null and "access_ends_on" is null)
        or ("product" = 'unlimited' and "entry_count" is null
          and ("tier" = 'open-space') = ("unlimited_coffee" is not null)
          and ("tier" = 'reserved-desk-workstation') = ("unlimited_monitor_option" is not null)));--> statement-breakpoint
ALTER TABLE "pass_purchases" DROP CONSTRAINT "pass_purchases_validity_check", ADD CONSTRAINT "pass_purchases_validity_check" CHECK ("valid_from" < "valid_until"
        and ("access_ends_on" is null or "access_ends_on" between "valid_from" and "valid_until"));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "mirror_reservation_order_on_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW."pass_id" IS NULL THEN
		PERFORM "mirror_reservation_order"(NEW);
	END IF;
	RETURN NULL;
END
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "remove_reservation_order"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF OLD."pass_id" IS NULL THEN
		DELETE FROM "orders"
		WHERE "id" = OLD."id"
			AND "kind" = 'reservation';
	END IF;
	RETURN NULL;
END
$function$;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
