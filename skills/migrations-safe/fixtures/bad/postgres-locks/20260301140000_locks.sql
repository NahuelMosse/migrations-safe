-- Each statement trips one rule.
SET lock_timeout = '5s';
ALTER TABLE orders ADD CONSTRAINT orders_ref_key UNIQUE (ref);
DROP INDEX orders_old_idx;
ALTER TABLE orders ADD COLUMN seq serial;
TRUNCATE order_events;
DROP SCHEMA reporting CASCADE;
DROP MATERIALIZED VIEW daily_totals;
ALTER TABLE orders ADD CONSTRAINT orders_pk PRIMARY KEY USING INDEX orders_pk_idx;
