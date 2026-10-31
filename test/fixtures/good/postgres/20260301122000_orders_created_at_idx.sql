-- Its own file: CONCURRENTLY cannot run in a transaction; the runner runs this one without it.
-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_created_at_idx ON orders (created_at);

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS orders_created_at_idx;
