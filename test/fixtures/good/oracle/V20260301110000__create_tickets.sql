CREATE TABLE tickets (
  id NUMBER(10) NOT NULL,
  user_id NUMBER(10) NOT NULL,
  status VARCHAR2(20) DEFAULT 'open' NOT NULL,
  CONSTRAINT pk_tickets PRIMARY KEY (id)
);
