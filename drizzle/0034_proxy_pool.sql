CREATE TABLE `proxy_pool` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`is_default` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `proxy_pool_default_idx` ON `proxy_pool` (`is_default`);--> statement-breakpoint
ALTER TABLE `sites` ADD `proxy_id` integer;