-- +goose Up
SET LOCK_TIMEOUT 5000;
ALTER TABLE [dbo].[Orders] ADD [Priority] int NULL;
GO

-- +goose Down
ALTER TABLE [dbo].[Orders] DROP COLUMN [Priority];
