IF NOT EXISTS(SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'20260301120000_AddPriority')
BEGIN
    EXEC(N'ALTER TABLE [Orders] ADD [Priority] int NOT NULL DEFAULT 0');
END;
GO

IF NOT EXISTS(SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'20260301121000_DropLegacy')
BEGIN
    EXEC(N'ALTER TABLE [Orders] DROP COLUMN [Legacy]');
END;
GO
