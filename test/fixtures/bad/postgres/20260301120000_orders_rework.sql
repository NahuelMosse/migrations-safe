-- Every statement here is a known way to break production on a populated table.

ALTER TABLE orders RENAME COLUMN total TO amount;

ALTER TABLE orders ALTER COLUMN status TYPE varchar(20);

ALTER TABLE orders ADD COLUMN currency char(3) NOT NULL;

ALTER TABLE orders ADD COLUMN public_id uuid DEFAULT gen_random_uuid();

ALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;

ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id);

CREATE INDEX orders_created_at_idx ON orders (created_at);

UPDATE orders SET currency = 'USD';

ALTER TABLE orders DROP COLUMN legacy_ref;

DROP TABLE order_notes;

ALTER TABLE customers RENAME TO clients;
