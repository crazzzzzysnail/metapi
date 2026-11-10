CREATE TABLE `site_billing_profiles` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`quota_per_unit` integer,
	`cny_per_usd` real,
	`quota_source` text,
	`rate_source` text,
	`captured_at` text,
	`updated_at` text DEFAULT (datetime('now'))
);
