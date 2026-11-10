CREATE TABLE IF NOT EXISTS "site_billing_profiles" ("site_id" INTEGER NOT NULL PRIMARY KEY, "quota_per_unit" INTEGER, "cny_per_usd" DOUBLE PRECISION, "quota_source" TEXT, "rate_source" TEXT, "captured_at" TEXT, "updated_at" TEXT DEFAULT to_char(timezone('UTC', CURRENT_TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS'));
ALTER TABLE "account_tokens" ADD COLUMN "auto_groups" TEXT;
