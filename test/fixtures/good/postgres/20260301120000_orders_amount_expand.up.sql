-- Expand: the new column next to the old one. The app writes both; a separate job backfills in batches.
SET lock_timeout = '5s';

BEGIN;
ALTER TABLE orders ADD COLUMN amount numeric(12, 2);
ALTER TABLE orders ADD COLUMN currency char(3) NOT NULL DEFAULT 'USD';
ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;
ALTER TABLE orders ADD CONSTRAINT orders_customer_id_not_null CHECK (customer_id IS NOT NULL) NOT VALID;

CREATE TABLE order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_id_idx ON order_events (order_id);
COMMIT;
