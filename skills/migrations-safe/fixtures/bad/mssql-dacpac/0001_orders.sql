-- migration-lint: irreversible -- baseline of the fixture, nothing to undo
CREATE TABLE [dbo].[Orders] (
    [Id] int NOT NULL,
    [Name] nvarchar(50) NULL,
    [Note] nvarchar(200) NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([Id] ASC)
);
