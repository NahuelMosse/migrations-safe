import assert from 'node:assert/strict';
import { test } from 'node:test';
import { learnTsql } from '../skills/migrations-safe/scripts/lib/mssql.mjs';
import { parseServerVersion } from '../skills/migrations-safe/scripts/lib/server-version.mjs';
import { findings, lintCli, put, scratch } from './helpers.mjs';

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

test('mssql-alter-column: a longer varchar/nvarchar/varbinary of the same nullability and collation is metadata-only when the old definition is known', () => {
  // the table comes from an earlier migration: a table created in the same file is new and gets no ALTER finding
  const tsql = new Map();
  learnTsql('CREATE TABLE t (id int, c varchar(50) NOT NULL, n nvarchar(20) NULL, b varbinary(10) NULL, k varchar(10) COLLATE Latin1_General_CI_AS NULL, p int PRIMARY KEY)', tsql);
  const alter = (def) => rules(`ALTER TABLE t ALTER COLUMN ${def};`, { tsql: new Map(tsql) }).filter((r) => r === 'mssql-alter-column');
  assert.deepEqual(alter('c varchar(100) NOT NULL'), []);
  assert.deepEqual(alter('n nvarchar(200) NULL'), []);
  assert.deepEqual(alter('n nvarchar(200)'), [], 'no NULL/NOT NULL keeps a nullable column nullable');
  assert.deepEqual(alter('b varbinary(64)'), []);
  assert.deepEqual(alter('c varchar(50) NOT NULL'), [], 'the same definition changes nothing');
  assert.deepEqual(alter('k varchar(20) COLLATE Latin1_General_CI_AS NULL'), []);
  assert.deepEqual(alter('c [varchar](100) NOT NULL'), []);
  // not metadata-only: the finding stays, and says what changes
  const why = (def) => run(`SET LOCK_TIMEOUT 5000;\nALTER TABLE t ALTER COLUMN ${def};`, { tsql: new Map(tsql) }).find((f) => f.rule === 'mssql-alter-column')?.message;
  assert.match(why('c varchar(100) NULL'), /Not a metadata-only change here: nullability changes to NULL/);
  assert.match(why('c varchar(10) NOT NULL'), /shrinks from 50 to 10/);
  assert.match(why('c varchar(max) NOT NULL'), /LOB storage/);
  assert.match(why('c nvarchar(100) NOT NULL'), /type changes from varchar to nvarchar/);
  assert.match(why('c bigint NOT NULL'), /type changes from varchar to bigint/);
  assert.match(why('k varchar(20) NULL'), /collation changes/);
  assert.match(why('n nvarchar(200) NOT NULL'), /nullability changes to NOT NULL/);
  assert.match(why('p int NULL'), /fixed-size type/);
});

test('mssql-alter-column: an earlier migration or --schema teaches the old definition; unknown keeps the error and says why', () => {
  assert.match(run('SET LOCK_TIMEOUT 5000;\nALTER TABLE t ALTER COLUMN c varchar(100) NOT NULL;').find((f) => f.rule === 'mssql-alter-column').message, /previous definition of c is unknown.*--schema/);
  const known = new Map([['t.c', { column: 'c', type: 'varchar', length: 50, nullable: false, collation: null }]]);
  assert.deepEqual(rules('ALTER TABLE t ALTER COLUMN c varchar(100) NOT NULL;', { tsql: known }), []);
  // a column widened in the same file is known afterwards
  assert.deepEqual(rules('ALTER TABLE t ADD c varchar(10) NULL;\nALTER TABLE t ALTER COLUMN c varchar(20) NULL;\nALTER TABLE t ALTER COLUMN c varchar(5) NULL;', { tsql: new Map(known) }).filter((r) => r === 'mssql-alter-column'), ['mssql-alter-column']);
});

test('mssql-alter-column: the definition comes from earlier migrations of the folder and from --schema', (t) => {
  const dir = scratch(t);
  put(dir, 'V1__create.sql', '-- migration-lint: dialect mssql\nCREATE TABLE t (id int, c varchar(50) NOT NULL);\n');
  put(dir, 'V2__widen.sql', '-- migration-lint: dialect mssql\nSET LOCK_TIMEOUT 5000;\nALTER TABLE t ALTER COLUMN c varchar(100) NOT NULL;\n');
  put(dir, 'V3__shrink.sql', '-- migration-lint: dialect mssql\nSET LOCK_TIMEOUT 5000;\nALTER TABLE t ALTER COLUMN c varchar(10) NOT NULL;\n');
  const r = JSON.parse(lintCli([dir, '--format', 'json']).out);
  const hits = r.findings.filter((f) => f.rule === 'mssql-alter-column').map((f) => f.file.split(/[\/]/).pop());
  assert.deepEqual(hits, ['V3__shrink.sql']);
  const lone = scratch(t);
  put(lone, 'V9__widen.sql', '-- migration-lint: dialect mssql\nSET LOCK_TIMEOUT 5000;\nALTER TABLE t ALTER COLUMN c varchar(100) NOT NULL;\n');
  assert.equal(JSON.parse(lintCli([lone, '--format', 'json']).out).findings.filter((f) => f.rule === 'mssql-alter-column').length, 1);
  const seed = put(scratch(t), 'schema.sql', 'CREATE TABLE t (id int, c varchar(50) NOT NULL);\n');
  assert.equal(JSON.parse(lintCli([lone, '--schema', seed, '--dialect', 'mssql', '--format', 'json']).out).findings.filter((f) => f.rule === 'mssql-alter-column').length, 0);
});
