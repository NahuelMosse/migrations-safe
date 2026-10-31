CREATE TABLE users (
  id int NOT NULL PRIMARY KEY,
  email nvarchar(100) NOT NULL,
  nickname nvarchar(50) NULL
);
CREATE TABLE orders (
  id int NOT NULL PRIMARY KEY,
  user_id int NOT NULL,
  amount decimal(10, 2) NOT NULL,
  note nvarchar(max) NULL,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
);
CREATE INDEX idx_orders_user_id ON orders (user_id);
INSERT INTO users (id, email, nickname) VALUES (1, N'ana@example.com', N'ana'), (2, N'bo@example.com', NULL), (3, N'cy@example.com', N'cy');
INSERT INTO orders (id, user_id, amount, note) VALUES (1, 1, 10.50, N'first'), (2, 1, 3.00, NULL), (3, 2, 99.99, N'gift'), (4, 3, 1.25, NULL);
