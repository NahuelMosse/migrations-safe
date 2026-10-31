-- migration-lint: irreversible -- fixture: nothing to restore
ALTER TABLE `tickets` DROP PRIMARY KEY, ALGORITHM=COPY;
ALTER TABLE `tickets` ADD FULLTEXT INDEX `ft_note` (`note`), ALGORITHM=INPLACE, LOCK=SHARED;
ALTER TABLE `tickets` ADD CONSTRAINT `fk_tickets_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`), ALGORITHM=COPY;
ALTER TABLE `tickets` ADD INDEX `idx_tickets_status` (`status`), ALGORITHM=INSTANT;
ALTER TABLE `tickets` CONVERT TO CHARACTER SET utf8mb4, ALGORITHM=COPY;
OPTIMIZE TABLE `tickets`;
ALTER TABLE `tickets` MODIFY COLUMN `status` ENUM('closed','open','resolved') NOT NULL, ALGORITHM=COPY;
ALTER TABLE `tickets` CHANGE COLUMN `note` `body` text, ALGORITHM=INPLACE;
