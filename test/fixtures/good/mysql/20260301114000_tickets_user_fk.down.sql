-- migration-lint: dialect mysql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE `tickets` DROP FOREIGN KEY `fk_tickets_user`, ALGORITHM=INPLACE, LOCK=NONE;
