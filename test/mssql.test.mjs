import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServerVersion } from '../skills/migrations-safe/scripts/lib/server-version.mjs';
import { findings } from './helpers.mjs';

const run = (sql, { edition = 'standard', version = '2022', ...ctx } = {}) => findings(sql, {
  dialect: 'mssql', runner: 'flyway', edition, serverVersion: parseServerVersion('mssql', version), ...ctx,
});
const rules = (sql, ctx) => run(`SET LOCK_TIMEOUT 5000;\n${sql}`, ctx).map((f) => f.rule).sort();
const one = (sql, ctx) => rules(sql, ctx);

test('mssql-add-not-null-default: NOT NULL with a default is a size-of-data change except on Enterprise with a runtime constant', () => {
  const add = 'ALTER TABLE t ADD c int NOT NULL DEFAULT 0;';
  assert.deepEqual(one(add), ['mssql-add-not-null-default']);
  assert.deepEqual(one(add, { edition: 'enterprise' }), []);
  assert.deepEqual(one(add, { edition: 'azure' }), []);
  assert.deepEqual(one('ALTER TABLE t ADD c uniqueidentifier NOT NULL DEFAULT NEWID();', { edition: 'enterprise' }), ['mssql-add-not-null-default']);
  assert.deepEqual(one('ALTER TABLE t ADD c datetime2 NOT NULL DEFAULT SYSUTCDATETIME();', { edition: 'enterprise' }), []);
  assert.deepEqual(one('ALTER TABLE t ADD c int NULL DEFAULT 0;'), []);
  assert.deepEqual(one('ALTER TABLE t ADD c int NULL DEFAULT 0 WITH VALUES;'), ['mssql-add-not-null-default']);
  assert.deepEqual(one('ALTER TABLE t ADD c int NOT NULL;'), ['not-null-without-default']);
  assert.deepEqual(one('CREATE TABLE t (id int); ALTER TABLE t ADD c int NOT NULL DEFAULT 0;'), []);
  assert.deepEqual(one('ALTER TABLE t ADD a int NULL, b int NOT NULL DEFAULT 1;'), ['mssql-add-not-null-default']);
});

test('mssql-alter-column: error without ONLINE or before 2016, a warning on Enterprise with ONLINE', () => {
  const alter = 'ALTER TABLE t ALTER COLUMN c bigint NOT NULL';
  assert.deepEqual(one(`${alter};`), ['mssql-alter-column']);
  assert.deepEqual(one(`${alter};`, { edition: 'enterprise' }), ['mssql-alter-column']);
  assert.equal(run(`SET LOCK_TIMEOUT 5000;\n${alter} WITH (ONLINE = ON);`, { edition: 'enterprise' })[0].level, 'warning');
  assert.deepEqual(one(`${alter} WITH (ONLINE = ON);`, { edition: 'enterprise', version: '2014' }), ['mssql-alter-column']);
  assert.match(run(`${alter} WITH (ONLINE = ON);`, { edition: 'enterprise', version: '2014' })[0].message, /does not exist before SQL Server 2016/);
  assert.deepEqual(one('ALTER TABLE t ALTER COLUMN c ADD SPARSE;'), []);
});

test('mssql-index-offline: CREATE INDEX, REBUILD and ADD PRIMARY KEY/UNIQUE on an existing table without ONLINE', () => {
  assert.deepEqual(one('CREATE INDEX ix ON t (c);', { edition: 'enterprise' }), ['mssql-index-offline']);
  assert.deepEqual(one('CREATE UNIQUE NONCLUSTERED INDEX ix ON dbo.t (c);'), ['mssql-index-offline']);
  assert.deepEqual(one('CREATE INDEX ix ON t (c) WITH (ONLINE = ON);', { edition: 'enterprise' }), []);
  assert.deepEqual(one('ALTER INDEX ix ON t REBUILD;', { edition: 'enterprise' }), ['mssql-index-offline']);
  assert.deepEqual(one('ALTER INDEX ix ON t REORGANIZE;', { edition: 'enterprise' }), []);
  assert.deepEqual(one('ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (id);', { edition: 'enterprise' }), ['mssql-index-offline']);
  assert.deepEqual(one('ALTER TABLE t ADD CONSTRAINT uq UNIQUE (c) WITH (ONLINE = ON);', { edition: 'enterprise' }), []);
  assert.deepEqual(one('ALTER TABLE t REBUILD;', { edition: 'enterprise' }), ['mssql-index-offline']);
  assert.deepEqual(one('CREATE TABLE t (id int); CREATE INDEX ix ON t (id);'), []);
});

test('mssql-online-unsupported-edition: ONLINE and RESUMABLE fail on Standard and Express', () => {
  assert.deepEqual(one('CREATE INDEX ix ON t (c) WITH (ONLINE = ON);'), ['mssql-online-unsupported-edition']);
  assert.deepEqual(one('CREATE INDEX ix ON t (c) WITH (ONLINE = ON, RESUMABLE = ON);', { edition: 'enterprise' }), []);
  assert.deepEqual(one('ALTER INDEX ix ON t REBUILD WITH (RESUMABLE = ON);'), ['mssql-online-unsupported-edition', 'mssql-index-offline'].sort());
  assert.deepEqual(one('ALTER TABLE t ALTER COLUMN c bigint WITH (ONLINE = ON);'), ['mssql-online-unsupported-edition']);
});

test('mssql-lock-timeout: DDL on an existing table needs SET LOCK_TIMEOUT or WAIT_AT_LOW_PRIORITY first', () => {
  const at = (sql, ctx) => run(sql, ctx).map((f) => f.rule);
  assert.deepEqual(at('ALTER TABLE t ADD c int NULL;'), ['mssql-lock-timeout']);
  assert.deepEqual(at('SET LOCK_TIMEOUT 5000;\nALTER TABLE t ADD c int NULL;'), []);
  assert.deepEqual(at('ALTER TABLE t ADD c int NULL;\nSET LOCK_TIMEOUT 5000;'), ['mssql-lock-timeout']);
  assert.deepEqual(at('ALTER INDEX ix ON t REBUILD WITH (ONLINE = ON (WAIT_AT_LOW_PRIORITY (MAX_DURATION = 1 MINUTES, ABORT_AFTER_WAIT = SELF)));', { edition: 'enterprise' }), []);
  assert.deepEqual(at('CREATE TABLE t (id int);'), []);
});

test('mssql-constraint-with-check and mssql-constraint-nocheck', () => {
  assert.deepEqual(one('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (u) REFERENCES users (id);'), ['mssql-constraint-with-check']);
  assert.deepEqual(one('ALTER TABLE t WITH CHECK ADD CONSTRAINT ck CHECK (a > 0);'), ['mssql-constraint-with-check']);
  assert.deepEqual(one('ALTER TABLE t WITH NOCHECK ADD CONSTRAINT ck CHECK (a > 0);'), ['mssql-constraint-nocheck']);
  assert.deepEqual(one('ALTER TABLE t WITH CHECK CHECK CONSTRAINT ck;'), []);
  assert.deepEqual(one('CREATE TABLE t (u int); ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (u) REFERENCES users (id);'), []);
});

test('sp_rename feeds rename-column and rename-table; DACPAC rebuilds are not renames', () => {
  assert.deepEqual(one("EXEC sp_rename 'dbo.t.c', 'd', 'COLUMN';"), ['rename-column']);
  assert.deepEqual(one("EXEC sp_rename N'[dbo].[t]', N't2';"), ['rename-table']);
  assert.deepEqual(one("EXEC sp_rename N'ix_t_c', N'ix_t_d', N'INDEX';"), []);
  assert.deepEqual(one("EXEC sp_rename 'tmp', 't2';\nCREATE TABLE tmp (id int);").includes('rename-table'), true);
});

test('drop-column says the space is not reclaimed until the clustered index is rebuilt', () => {
  const f = run('SET LOCK_TIMEOUT 5000;\nALTER TABLE t DROP COLUMN a, b;').filter((x) => x.rule === 'drop-column');
  assert.equal(f.length, 2, 'one finding per dropped column');
  assert.match(f[0].message, /clustered index is rebuilt/);
});

test('an idempotent EF script keeps its ALTER visible to the rules', () => {
  const sql = "IF NOT EXISTS(SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'x')\nBEGIN\n    EXEC(N'ALTER TABLE [Orders] ADD [P] int NOT NULL DEFAULT 0');\nEND;\nGO\n";
  assert.ok(run(sql).some((f) => f.rule === 'mssql-add-not-null-default'));
});
