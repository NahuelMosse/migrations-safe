-- Validate what the previous migration added NOT VALID: takes only SHARE UPDATE EXCLUSIVE, reads and writes go on.
-- The runner (dbmate) wraps the file in a transaction, so the file has no BEGIN/COMMIT of its own.
-- migrate:up
SET lock_timeout = '5s';
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_fk;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_id_not_null;

-- migrate:down
-- Validation has nothing to undo.
