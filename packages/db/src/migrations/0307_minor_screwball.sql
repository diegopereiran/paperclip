ALTER TABLE "issues" ADD COLUMN "accepted_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "accepted_outcome_ref" text;