ALTER SESSION SET DDL_LOCK_TIMEOUT = 30;
-- migration-lint: allow oracle-index-not-online -- Standard Edition 2 has no ONLINE; tickets holds under 10k rows, the build takes milliseconds (PLAT-212)
CREATE INDEX ix_tickets_status ON tickets (status);
