CREATE TABLE IF NOT EXISTS `site_billing_profiles` (`site_id` INT NOT NULL PRIMARY KEY, `quota_per_unit` INT, `cny_per_usd` DOUBLE, `quota_source` TEXT, `rate_source` TEXT, `captured_at` VARCHAR(191), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')));
ALTER TABLE `account_tokens` ADD COLUMN `auto_groups` TEXT;
