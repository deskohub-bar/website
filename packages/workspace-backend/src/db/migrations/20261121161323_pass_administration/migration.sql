CREATE TABLE "pass_administration_changes" (
	"request_id" uuid PRIMARY KEY,
	"pass_id" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"actor_account_email" text NOT NULL,
	"reason" text NOT NULL,
	"change" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"hold_rollback_at" timestamp with time zone,
	"transfer_progress" jsonb,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "pass_administration_changes_result_check" CHECK (num_nonnulls("completed_at", "failed_at") <= 1
        and ("completed_at" is null or "completed_at" >= "requested_at")
        and ("failed_at" is null or "failed_at" >= "requested_at")
        and ("hold_rollback_at" is null or
          ("completed_at" is null and "hold_rollback_at" >= "requested_at")))
);
--> statement-breakpoint
ALTER TABLE "entry_pack_gift_invitations" ADD COLUMN "first_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "holder_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "pass_administration_changes_pass_requested_idx" ON "pass_administration_changes" ("pass_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pass_administration_changes_pending_pass_idx" ON "pass_administration_changes" ("pass_id") WHERE "completed_at" is null and "failed_at" is null;--> statement-breakpoint
ALTER TABLE "pass_administration_changes" ADD CONSTRAINT "pass_administration_changes_pass_id_pass_purchases_id_fkey" FOREIGN KEY ("pass_id") REFERENCES "pass_purchases"("id");--> statement-breakpoint
ALTER TABLE "pass_administration_changes" ADD CONSTRAINT "pass_administration_changes_2R11NicRa2wi_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "customer_accounts"("id");--> statement-breakpoint
ALTER TABLE "entry_pack_gift_invitations" ADD CONSTRAINT "entry_pack_gift_first_generation_check" CHECK ("first_generation" between 0 and "generation");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_complimentary_check" CHECK ("payment_state" <> 'complimentary' or ("kind" = 'pass-purchase'
        and "active_payment_attempt_id" is null and "paid_at" is null));--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_state_check", ADD CONSTRAINT "orders_payment_state_check" CHECK ("payment_state" in ('not_started', 'pending', 'paid', 'failed', 'cancelled', 'expired', 'complimentary'));