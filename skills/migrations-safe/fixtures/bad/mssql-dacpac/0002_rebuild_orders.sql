:setvar DatabaseName "app"
GO
SET XACT_ABORT ON;
GO
BEGIN TRANSACTION;

CREATE TABLE [dbo].[tmp_ms_xx_Orders] (
    [Id]   int           NOT NULL,
    [Name] nvarchar(50)  NULL,
    CONSTRAINT [tmp_ms_xx_constraint_PK_Orders] PRIMARY KEY CLUSTERED ([Id] ASC)
);

IF EXISTS (SELECT TOP 1 1 FROM [dbo].[Orders])
    BEGIN
        INSERT INTO [dbo].[tmp_ms_xx_Orders] ([Id], [Name])
        SELECT   [Id],
                 [Name]
        FROM     [dbo].[Orders]
        ORDER BY [Id] ASC;
    END

DROP TABLE [dbo].[Orders];

EXECUTE sp_rename N'[dbo].[tmp_ms_xx_Orders]', N'Orders';

COMMIT TRANSACTION;
GO
