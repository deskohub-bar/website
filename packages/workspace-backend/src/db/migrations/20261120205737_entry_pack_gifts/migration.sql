CREATE TABLE "entry_pack_gift_invitations" (
	"order_id" text PRIMARY KEY,
	"holder_account_id" text NOT NULL,
	"locale" text NOT NULL,
	"generation" integer NOT NULL,
	"context_id" uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
	"attempts" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"key_id" text,
	"callback_origin" text,
	"delivery_fingerprint" text,
	"confirmation_invited" boolean,
	CONSTRAINT "entry_pack_gift_generation_check" CHECK ("generation" >= 0),
	CONSTRAINT "entry_pack_gift_attempts_check" CHECK ("attempts" >= 0),
	CONSTRAINT "entry_pack_gift_accepted_check" CHECK ("sent_at" is null or ("next_attempt_at" is null and "key_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "gift_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD COLUMN "gift_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "signed_in_with_credential" boolean;--> statement-breakpoint
CREATE INDEX "entry_pack_gift_next_attempt_idx" ON "entry_pack_gift_invitations" ("next_attempt_at") WHERE ("next_attempt_at" is not null);--> statement-breakpoint
ALTER TABLE "entry_pack_gift_invitations" ADD CONSTRAINT "entry_pack_gift_invitations_order_id_pass_purchases_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pass_purchases"("id");--> statement-breakpoint
ALTER TABLE "entry_pack_gift_invitations" ADD CONSTRAINT "entry_pack_gift_invitations_35svas1nabDV_fkey" FOREIGN KEY ("holder_account_id") REFERENCES "customer_accounts"("id");--> statement-breakpoint
ALTER TABLE "pass_purchases" ADD CONSTRAINT "pass_purchases_gift_claim_check" CHECK (("gift_issued_at" is null and "gift_claimed_at" is null) or "holder_account_id" <> "buyer_account_id");