CREATE TABLE tickets (
  id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  CONSTRAINT pk_tickets PRIMARY KEY (id)
);
