-- migration-lint: dialect mysql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE `tickets` DROP INDEX `idx_tickets_status`, ALGORITHM=INPLACE, LOCK=NONE;
