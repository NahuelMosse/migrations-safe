-- migration-lint: dialect mysql
SET SESSION lock_wait_timeout = 5;
UPDATE `tickets` SET `status` = 'closed' WHERE `status` = 'archived';
ALTER TABLE `tickets` MODIFY COLUMN `status` ENUM('open','closed') NOT NULL DEFAULT 'open', ALGORITHM=COPY;
