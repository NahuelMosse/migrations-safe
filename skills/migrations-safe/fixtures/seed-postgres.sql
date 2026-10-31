CREATE TABLE users (
  id integer PRIMARY KEY,
  email text NOT NULL,
  nickname text
);
CREATE TABLE orders (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id),
  amount numeric(10, 2) NOT NULL,
  note text
);
INSERT INTO users (id, email, nickname) VALUES (1, 'ana@example.com', 'ana'), (2, 'bo@example.com', NULL), (3, 'cy@example.com', 'cy');
INSERT INTO orders (id, user_id, amount, note) VALUES (1, 1, 10.50, 'first'), (2, 1, 3.00, NULL), (3, 2, 99.99, 'gift'), (4, 3, 1.25, NULL);
