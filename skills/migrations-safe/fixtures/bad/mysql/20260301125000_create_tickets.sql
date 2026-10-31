-- migration-lint: irreversible -- fixture: nothing to restore
CREATE TABLE `tickets` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `status` ENUM('open','closed','resolved') NOT NULL,
  `note` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
