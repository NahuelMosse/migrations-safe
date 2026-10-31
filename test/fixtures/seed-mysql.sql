CREATE TABLE users (
  id int NOT NULL PRIMARY KEY,
  email varchar(100) NOT NULL,
  nickname varchar(50) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE orders (
  id int NOT NULL PRIMARY KEY,
  user_id int NOT NULL,
  amount decimal(10, 2) NOT NULL,
  note text NULL,
  KEY idx_orders_user_id (user_id),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO users (id, email, nickname) VALUES (1, 'ana@example.com', 'ana'), (2, 'bo@example.com', NULL), (3, 'cy@example.com', 'cy');
INSERT INTO orders (id, user_id, amount, note) VALUES (1, 1, 10.50, 'first'), (2, 1, 3.00, NULL), (3, 2, 99.99, 'gift'), (4, 3, 1.25, NULL);
