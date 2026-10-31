BEGIN;
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
COMMIT;
