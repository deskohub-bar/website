CREATE TABLE "reservation_audit_accesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"reservation_id" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"before_event_id" uuid,
	"returned_count" integer NOT NULL,
	CONSTRAINT "reservation_audit_accesses_source_check" CHECK ("source" in ('admin-ui', 'dhw-cli', 'assistant')),
	CONSTRAINT "reservation_audit_accesses_count_check" CHECK ("returned_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservation_audit_events" (
	"id" uuid PRIMARY KEY,
	"reservation_id" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"source" text NOT NULL,
	"before_state" text NOT NULL,
	"after_state" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"correlation_id" uuid NOT NULL,
	"administration_action_id" uuid,
	"caused_by_event_id" uuid,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reservation_audit_events_source_check" CHECK ("source" in ('admin-ui', 'dhw-cli', 'assistant')),
	CONSTRAINT "reservation_audit_events_version_check" CHECK ("schema_version" = 1),
	CONSTRAINT "reservation_audit_events_transition_check" CHECK (case
        when "reason" in ('operator_cancellation', 'forced_pending_payment_cancellation')
          then "before_state" in ('held', 'hold_expired', 'confirmed') and "after_state" = 'cancelling' and "caused_by_event_id" is null
        when "reason" = 'cancellation_reclaimed'
          then "before_state" in ('cancelling', 'cancellation_failed') and "after_state" = 'cancelling' and "caused_by_event_id" is null
        when "reason" in ('provider_cancellation_failed', 'local_cancellation_failed')
          then "before_state" = 'cancelling' and "after_state" = 'cancellation_failed' and "caused_by_event_id" is not null
        when "reason" = 'cancellation_completed'
          then "before_state" = 'cancelling' and "after_state" = 'cancelled' and "caused_by_event_id" is not null
        when "reason" = 'operator_restoration'
          then "before_state" = 'cancelled' and "after_state" = 'confirmed' and "caused_by_event_id" is null
        else false
      end)
);
--> statement-breakpoint
CREATE INDEX "reservation_audit_accesses_subject_time_idx" ON "reservation_audit_accesses" ("reservation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "reservation_audit_events_subject_order_idx" ON "reservation_audit_events" ("reservation_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "reservation_audit_events" ADD CONSTRAINT "reservation_audit_events_cause_fk" FOREIGN KEY ("caused_by_event_id") REFERENCES "reservation_audit_events"("id");
--> statement-breakpoint
CREATE FUNCTION reject_reservation_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reservation audit records are append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reservation_audit_events_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON reservation_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_reservation_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER reservation_audit_accesses_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON reservation_audit_accesses
  FOR EACH STATEMENT EXECUTE FUNCTION reject_reservation_audit_mutation();
