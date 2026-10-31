-- migration-lint: dialect mysql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE `tickets` ADD INDEX `idx_tickets_status` (`status`), ALGORITHM=INPLACE, LOCK=NONE;
