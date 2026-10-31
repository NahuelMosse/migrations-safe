CREATE TABLE users (
  id NUMBER(10) NOT NULL PRIMARY KEY,
  email VARCHAR2(100) NOT NULL,
  nickname VARCHAR2(50) NULL
);
CREATE TABLE orders (
  id NUMBER(10) NOT NULL PRIMARY KEY,
  user_id NUMBER(10) NOT NULL,
  amount NUMBER(10, 2) NOT NULL,
  note VARCHAR2(200) NULL,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE INDEX idx_orders_user_id ON orders (user_id);
INSERT INTO users (id, email, nickname) VALUES (1, 'ana@example.com', 'ana');
INSERT INTO users (id, email, nickname) VALUES (2, 'bo@example.com', NULL);
INSERT INTO users (id, email, nickname) VALUES (3, 'cy@example.com', 'cy');
INSERT INTO orders (id, user_id, amount, note) VALUES (1, 1, 10.50, 'first');
INSERT INTO orders (id, user_id, amount, note) VALUES (2, 1, 3.00, NULL);
INSERT INTO orders (id, user_id, amount, note) VALUES (3, 2, 99.99, 'gift');
INSERT INTO orders (id, user_id, amount, note) VALUES (4, 3, 1.25, NULL);
COMMIT;
