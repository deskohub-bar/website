SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "mock_payment_sessions" (
	"payment_id" text PRIMARY KEY,
	"capability_hash" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"return_url" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refunded_amount_minor" integer,
	CONSTRAINT "mock_payment_sessions_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "mock_payment_sessions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "mock_payment_sessions_outcome_check" CHECK ("outcome" in ('pending', 'approved', 'declined') and ("outcome" = 'pending') = ("decided_at" is null)),
	CONSTRAINT "mock_payment_sessions_refund_check" CHECK (("refunded_at" is null and "refunded_amount_minor" is null) or ("outcome" = 'approved' and "refunded_at" is not null and "refunded_amount_minor" is not null and "refunded_amount_minor" > 0 and "refunded_amount_minor" <= "amount_minor"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_order_unique_idx" ON "payment_attempts" ("provider","provider_order_id");--> statement-breakpoint
DROP INDEX "payment_attempts_nexi_order_unique_idx";--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
UPDATE "webhook_events" SET "provider_event_id" = "event_id";--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "provider_event_id" SET NOT NULL;--> statement-breakpoint
-- Older Nexi writers still target event_id in ON CONFLICT. Keep the legacy
-- arbiter and mirror Nexi IDs until those deployments have drained.
ALTER TABLE "webhook_events" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
CREATE FUNCTION "mirror_nexi_webhook_event_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	NEW."event_id" := COALESCE(NEW."event_id", NEW."provider_event_id");
	NEW."provider_event_id" := COALESCE(NEW."provider_event_id", NEW."event_id");
	-- The composite index is a second unique constraint for Nexi. Serialize
	-- inserts of the same ID before PostgreSQL checks either unique index.
	PERFORM pg_advisory_xact_lock(hashtextextended('webhook_events/nexi/' || NEW."event_id", 0));
	RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "webhook_events_nexi_event_id_mirror"
BEFORE INSERT ON "webhook_events"
FOR EACH ROW
WHEN (NEW."provider" = 'nexi')
EXECUTE FUNCTION "mirror_nexi_webhook_event_id"();--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_unique_idx" ON "webhook_events" ("provider","provider_event_id");--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_legacy_event_id_check" CHECK (("provider" = 'nexi' and "event_id" is not null and "event_id" = "provider_event_id") or ("provider" = 'mock' and "event_id" is null));--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_provider_check", ADD CONSTRAINT "payment_attempts_provider_check" CHECK ("provider" in ('nexi', 'mock', 'internal'));--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_refund_state_check", ADD CONSTRAINT "payment_attempts_refund_state_check" CHECK ("refund_state" in ('not_required', 'required', 'refunded') and ("refund_state" = 'not_required' or ("provider" in ('nexi', 'mock') and "state" = 'paid')));--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_amount_check", ADD CONSTRAINT "payment_attempts_amount_check" CHECK (("provider" in ('nexi', 'mock') and "amount_value" > 0) or ("provider" = 'internal' and "amount_value" = 0));--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_provider_fields_check", ADD CONSTRAINT "payment_attempts_provider_fields_check" CHECK (("provider" in ('nexi', 'mock') and "provider_order_id" is not null) or ("provider" = 'internal' and "provider_order_id" is null and "security_token" is null and "provider_redirect_url" is null and "last_webhook_event_id" is null and "last_provider_operation_id" is null and "last_provider_status" is null and "provider_order_created_at" is null));--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_provider_check", ADD CONSTRAINT "webhook_events_provider_check" CHECK ("provider" in ('nexi', 'mock'));--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
