SET LOCK_TIMEOUT 5000;
-- migration-lint: allow mssql-constraint-nocheck -- validated by V20260301114000 after the orphan query came back empty (PLAT-213)
ALTER TABLE [dbo].[Tickets] WITH NOCHECK ADD CONSTRAINT [FK_Tickets_Users] FOREIGN KEY ([UserId]) REFERENCES [dbo].[Users] ([Id]);
