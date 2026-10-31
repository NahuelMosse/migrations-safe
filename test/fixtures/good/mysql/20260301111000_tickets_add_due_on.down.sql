-- migration-lint: dialect mysql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE `tickets` DROP COLUMN `due_on`, ALGORITHM=INSTANT;
