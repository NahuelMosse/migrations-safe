SET LOCK_TIMEOUT 5000;
-- a nullable column is a metadata change on every edition
ALTER TABLE [dbo].[Tickets] ADD [DueOn] date NULL;
