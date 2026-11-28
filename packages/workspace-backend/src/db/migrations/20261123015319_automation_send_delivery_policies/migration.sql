CREATE TABLE "email_campaign_automation_customer_claims" (
	"campaign_id" text,
	"dotypos_customer_id" text,
	"run_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_campaign_automation_customer_claims_pkey" PRIMARY KEY("campaign_id","dotypos_customer_id")
);
--> statement-breakpoint
ALTER TABLE "email_campaign_automation_preview_rows" ADD COLUMN "skip_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "email_campaign_automation_customer_claims_run_idx" ON "email_campaign_automation_customer_claims" ("run_id");--> statement-breakpoint
ALTER TABLE "email_campaign_automation_customer_claims" ADD CONSTRAINT "email_campaign_automation_customer_claims_p1cYmX1mcb6e_fkey" FOREIGN KEY ("campaign_id") REFERENCES "email_campaigns"("id");--> statement-breakpoint
ALTER TABLE "email_campaign_automation_customer_claims" ADD CONSTRAINT "email_campaign_automation_customer_claims_Yo21e0UNbh0P_fkey" FOREIGN KEY ("run_id") REFERENCES "email_campaign_automation_runs"("id");--> statement-breakpoint
ALTER TABLE "email_campaign_automation_preview_rows" ADD CONSTRAINT "email_campaign_automation_preview_rows_skip_reason_check" CHECK (("outcome" = 'skipped') = ("skip_reason" is not null) and ("skip_reason" is null or "skip_reason" in ('missing-from-dotypos', 'deleted-customer', 'missing-email', 'invalid-email', 'consent-withdrawn', 'outside-test-domain', 'pass-holder', 'already-sent-once')));--> statement-breakpoint
ALTER TABLE "email_campaign_automation_preview_rows" DROP CONSTRAINT "email_campaign_automation_preview_rows_outcome_check", ADD CONSTRAINT "email_campaign_automation_preview_rows_outcome_check" CHECK ("outcome" in ('would-send', 'condition-failed', 'not-in-audience', 'already-active', 'withdrawn', 'skipped', 'unavailable'));--> statement-breakpoint
ALTER TABLE "email_campaign_recipients" DROP CONSTRAINT "email_campaign_recipients_skip_reason_check", ADD CONSTRAINT "email_campaign_recipients_skip_reason_check" CHECK (("status" = 'skipped') = ("skip_reason" is not null) and ("skip_reason" is null or "skip_reason" in ('missing-from-dotypos', 'deleted-customer', 'missing-email', 'invalid-email', 'consent-withdrawn', 'outside-test-domain', 'missing-email-language', 'pass-holder')));