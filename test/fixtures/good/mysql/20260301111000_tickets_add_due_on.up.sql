-- migration-lint: dialect mysql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE `tickets` ADD COLUMN `due_on` date NULL, ALGORITHM=INSTANT;
