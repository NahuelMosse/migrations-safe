-- migration-lint: dialect mysql
-- The orphan check (SELECT ... LEFT JOIN users ... WHERE users.id IS NULL) ran before this file; the key is
-- added with checks off so the ALTER is INPLACE instead of a table copy.
SET SESSION lock_wait_timeout = 5;
SET SESSION foreign_key_checks = 0;
ALTER TABLE `tickets` ADD CONSTRAINT `fk_tickets_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`), ALGORITHM=INPLACE, LOCK=NONE;
SET SESSION foreign_key_checks = 1;
