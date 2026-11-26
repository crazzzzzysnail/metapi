CREATE TABLE IF NOT EXISTS `proxy_pool` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `name` TEXT NOT NULL, `url` TEXT NOT NULL, `is_default` BOOLEAN DEFAULT false, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')));
ALTER TABLE `sites` ADD COLUMN `proxy_id` INT;
CREATE INDEX `proxy_pool_default_idx` ON `proxy_pool` (`is_default`);
