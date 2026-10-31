-- migration-lint: dialect db2
CREATE INDEX ix_tickets_status ON tickets (status);
