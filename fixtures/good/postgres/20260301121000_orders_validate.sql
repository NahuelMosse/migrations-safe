-- Validate what the previous migration added NOT VALID: takes only SHARE UPDATE EXCLUSIVE, reads and writes go on.
-- migrate:up
SET lock_timeout = '5s';
BEGIN;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_fk;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_id_not_null;
COMMIT;

-- migrate:down
-- Validation has nothing to undo.
