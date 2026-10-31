-- migration-lint: dialect mysql
CREATE TABLE `tickets` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `status` ENUM('open','closed') NOT NULL DEFAULT 'open',
  PRIMARY KEY (`id`),
  KEY `idx_tickets_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
