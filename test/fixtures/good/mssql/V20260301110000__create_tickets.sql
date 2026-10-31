CREATE TABLE [dbo].[Tickets] (
    [Id] int NOT NULL,
    [UserId] int NOT NULL,
    [Status] nvarchar(20) NOT NULL CONSTRAINT [DF_Tickets_Status] DEFAULT N'open',
    CONSTRAINT [PK_Tickets] PRIMARY KEY CLUSTERED ([Id])
);
CREATE INDEX [IX_Tickets_UserId] ON [dbo].[Tickets] ([UserId]);
