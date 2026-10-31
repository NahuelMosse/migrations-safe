CREATE TABLE users (
  id INTEGER NOT NULL PRIMARY KEY,
  email VARCHAR(100) NOT NULL,
  nickname VARCHAR(50)
);
CREATE TABLE orders (
  id INTEGER NOT NULL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  note VARCHAR(200),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE INDEX idx_orders_user_id ON orders (user_id);
INSERT INTO users (id, email, nickname) VALUES (1, 'ana@example.com', 'ana'), (2, 'bo@example.com', NULL), (3, 'cy@example.com', 'cy');
INSERT INTO orders (id, user_id, amount, note) VALUES (1, 1, 10.50, 'first'), (2, 1, 3.00, NULL), (3, 2, 99.99, 'gift'), (4, 3, 1.25, NULL);
