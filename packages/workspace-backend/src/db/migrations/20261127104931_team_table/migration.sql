CREATE TABLE "open_space_table_move_batches" (
	"id" uuid PRIMARY KEY,
	"first_date" date NOT NULL,
	"last_date" date NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "open_space_table_move_batches_dates_check" CHECK ("last_date" between "first_date" and "first_date" + 2)
);
--> statement-breakpoint
CREATE TABLE "open_space_table_moves" (
	"generation" uuid PRIMARY KEY,
	"batch_id" uuid NOT NULL,
	"reservation_id" text NOT NULL,
	"service_date" date NOT NULL,
	"customer_id" text NOT NULL,
	"source_reservation_id" text NOT NULL,
	"source_table_id" text NOT NULL,
	"source_note_line" text NOT NULL,
	"target_table_id" text NOT NULL,
	"target_reservation_id" text,
	"status" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"ambiguous_at" timestamp with time zone,
	"ambiguous_reservation_ids" text[],
	CONSTRAINT "open_space_table_moves_booking_check" CHECK ("starts_at" < "ends_at"
        and "status" in ('NEW', 'CONFIRMED')
        and "target_table_id" <> "source_table_id"
        and "target_reservation_id" is distinct from "source_reservation_id"
        and ("target_reservation_id" is null or "attempted_at" is not null)
        and ("attached_at" is null or "target_reservation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "team_table_hold_claims" (
	"reservation_id" text PRIMARY KEY,
	"table_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"seats" integer NOT NULL,
	"provider_reservation_ids" text[],
	"checked_at" timestamp with time zone,
	"generation" uuid,
	"purpose" text DEFAULT 'checkout' NOT NULL,
	"payment_attempt_id" text,
	"retry_expires_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "team_table_hold_claims_interval" CHECK ("starts_at" < "ends_at"),
	CONSTRAINT "team_table_hold_claims_seats" CHECK ("seats" > 0),
	CONSTRAINT "team_table_hold_claims_owner" CHECK (
      ("purpose" = 'checkout' and "payment_attempt_id" is null)
      or ("purpose" in ('payment_retry', 'late_payment') and
        "payment_attempt_id" is not null and "generation" is not null)
    )
);
--> statement-breakpoint
ALTER TABLE "workspace_reservations" ADD COLUMN "active_customer_email_delivery_open_space_tables" text;--> statement-breakpoint
CREATE UNIQUE INDEX "open_space_table_moves_pending_reservation_idx" ON "open_space_table_moves" ("reservation_id") WHERE "settled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "open_space_table_moves_pending_source_idx" ON "open_space_table_moves" ("source_reservation_id") WHERE "settled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "open_space_table_moves_target_idx" ON "open_space_table_moves" ("target_reservation_id");--> statement-breakpoint
CREATE INDEX "open_space_table_moves_source_idx" ON "open_space_table_moves" ("source_reservation_id");--> statement-breakpoint
CREATE INDEX "open_space_table_moves_reservation_idx" ON "open_space_table_moves" ("reservation_id");--> statement-breakpoint
CREATE INDEX "open_space_table_moves_pending_date_idx" ON "open_space_table_moves" ("service_date") WHERE "settled_at" is null and "attempted_at" is not null;--> statement-breakpoint
CREATE INDEX "open_space_table_moves_pending_checked_idx" ON "open_space_table_moves" ("checked_at","batch_id") WHERE "settled_at" is null and "ambiguous_at" is null;--> statement-breakpoint
CREATE INDEX "open_space_table_moves_batch_idx" ON "open_space_table_moves" ("batch_id");--> statement-breakpoint
CREATE INDEX "team_table_hold_claims_interval_idx" ON "team_table_hold_claims" ("ends_at","starts_at");--> statement-breakpoint
ALTER TABLE "open_space_table_moves" ADD CONSTRAINT "open_space_table_moves_ha5oUveoSeYa_fkey" FOREIGN KEY ("batch_id") REFERENCES "open_space_table_move_batches"("id");--> statement-breakpoint
ALTER TABLE "open_space_table_moves" ADD CONSTRAINT "open_space_table_moves_KTLaSVJAnLJg_fkey" FOREIGN KEY ("reservation_id") REFERENCES "workspace_reservations"("id");--> statement-breakpoint
ALTER TABLE "team_table_hold_claims" ADD CONSTRAINT "team_table_hold_claims_GG82H69LKXnb_fkey" FOREIGN KEY ("reservation_id") REFERENCES "workspace_reservations"("id") ON DELETE CASCADE;