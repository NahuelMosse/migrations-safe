-- migration-lint: dialect mysql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE `tickets` MODIFY COLUMN `status` ENUM('open','closed','archived') NOT NULL DEFAULT 'open', ALGORITHM=INSTANT;
