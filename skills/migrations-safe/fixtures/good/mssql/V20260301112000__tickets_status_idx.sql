SET LOCK_TIMEOUT 5000;
-- migration-lint: allow mssql-index-offline -- Standard edition has no ONLINE; Tickets holds under 10k rows, build takes milliseconds (PLAT-212)
CREATE INDEX [IX_Tickets_Status] ON [dbo].[Tickets] ([Status]);
