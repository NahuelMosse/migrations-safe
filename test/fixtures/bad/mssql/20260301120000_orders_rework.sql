ALTER TABLE [dbo].[Orders] ADD [Priority] int NOT NULL DEFAULT 0;
ALTER TABLE [dbo].[Orders] ALTER COLUMN [Note] nvarchar(200) NOT NULL;
CREATE INDEX [IX_Orders_UserId] ON [dbo].[Orders] ([UserId]);
CREATE INDEX [IX_Orders_Note] ON [dbo].[Orders] ([Note]) WITH (ONLINE = ON);
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [FK_Orders_Users] FOREIGN KEY ([UserId]) REFERENCES [dbo].[Users] ([Id]);
ALTER TABLE [dbo].[Orders] WITH NOCHECK ADD CONSTRAINT [CK_Orders_Amount] CHECK ([Amount] >= 0);
ALTER TABLE [dbo].[Orders] DROP COLUMN [Legacy];
EXEC sp_rename 'Orders.Note', 'Memo', 'COLUMN';
GO
