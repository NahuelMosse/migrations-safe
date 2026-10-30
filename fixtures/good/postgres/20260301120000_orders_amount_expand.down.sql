SET lock_timeout = '5s';

BEGIN;
DROP TABLE order_events;
ALTER TABLE orders DROP CONSTRAINT orders_customer_id_not_null;
ALTER TABLE orders DROP CONSTRAINT orders_customer_fk;
ALTER TABLE orders DROP COLUMN currency;
ALTER TABLE orders DROP COLUMN amount;
COMMIT;
