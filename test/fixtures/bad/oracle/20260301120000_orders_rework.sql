-- migration-lint: dialect oracle
INSERT INTO orders (id, user_id, amount) VALUES (99, 1, 1);
ALTER TABLE orders ADD (priority NUMBER DEFAULT 0);
CREATE INDEX ix_orders_note ON orders (note);
CREATE INDEX ix_orders_user ON orders (user_id) ONLINE;
ALTER TABLE orders ADD CONSTRAINT fk_orders_users FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE orders DROP COLUMN legacy;
ALTER TABLE orders MOVE ONLINE;
