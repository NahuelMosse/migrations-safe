import assert from 'node:assert/strict';
import { test } from 'node:test';
import { name, parse, splitTopLevel } from '../skills/migrations-safe/scripts/lib/parse.mjs';

const texts = (sql, dialect) => parse(sql, { dialect }).statements.map((s) => s.text);

test('T-SQL: GO ends a batch only on a line of its own, with an optional count and comment', () => {
  const s = parse("CREATE TABLE a (x int)\nGO 2 -- twice\nINSERT INTO a VALUES ('\nGO\n')\ngo\nDROP TABLE a\n", { dialect: 'mssql' }).statements;
  assert.deepEqual(s.map((x) => x.batch), [0, 1, 2]);
  assert.match(s[1].text, /^INSERT INTO a VALUES \('\nGO\n'\)$/);
  assert.equal(parse('SELECT 1 /*\nGO\n*/\n', { dialect: 'mssql' }).statements.length, 1);
});

test('T-SQL: [bracketed;identifiers] and N-strings do not split', () => {
  assert.deepEqual(texts("ALTER TABLE [dbo].[a;b] ADD [c]]d] nvarchar(10) NULL; INSERT INTO [a;b] VALUES (N'x;y');", 'mssql'),
    ['ALTER TABLE [dbo].[a;b] ADD [c]]d] nvarchar(10) NULL', "INSERT INTO [a;b] VALUES (N'x;y')"]);
});

test('T-SQL without semicolons is split at statement keywords, not inside parentheses or continuations', () => {
  const sql = 'ALTER TABLE t\n  DROP COLUMN c\nALTER TABLE t\n  ALTER COLUMN d int NOT NULL\nSET NOCOUNT ON\nCREATE TABLE u (\n  a int,\n  b int\n)\nINSERT INTO t (a)\nSELECT 1\nUNION ALL\nSELECT 2\nUPDATE t\nSET a = 1\nCREATE INDEX i ON t (a)\nWITH (ONLINE = ON)\n';
  assert.deepEqual(texts(sql, 'mssql').map((t) => t.split(/\s+/).slice(0, 3).join(' ')), [
    'ALTER TABLE t', 'ALTER TABLE t', 'SET NOCOUNT ON', 'CREATE TABLE u', 'INSERT INTO t', 'UPDATE t SET', 'CREATE INDEX i',
  ]);
});

test('T-SQL: CREATE PROCEDURE and triggers run to the end of the batch, BEGIN..END keeps its statements together', () => {
  const sql = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND\nGO\nALTER TABLE t ADD c int\n';
  assert.deepEqual(texts(sql, 'mssql').length, 2);
  const guarded = 'BEGIN TRANSACTION\nALTER TABLE t ADD c int\nCOMMIT\n';
  assert.deepEqual(texts(guarded, 'mssql'), ['BEGIN TRANSACTION', 'ALTER TABLE t ADD c int', 'COMMIT']);
});

test('T-SQL: the guard of an idempotent script is dropped and EXEC(N\'...\') is read as the SQL it runs', () => {
  const ef = "IF NOT EXISTS(SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'20260101_x')\nBEGIN\n    EXEC(N'ALTER TABLE [Orders] ADD [Note] nvarchar(max) NULL; ');\nEND;\nGO\nEXEC sp_executesql N'ALTER TABLE [Orders] DROP COLUMN [Old]';\n";
  assert.deepEqual(texts(ef, 'mssql'), ['ALTER TABLE [Orders] ADD [Note] nvarchar(max) NULL', 'END', 'ALTER TABLE [Orders] DROP COLUMN [Old]']);
  assert.deepEqual(texts("EXEC(N'ALTER TABLE t ADD c nvarchar(max) DEFAULT N''x'' NULL');", 'mssql'), ["ALTER TABLE t ADD c nvarchar(max) DEFAULT N'x' NULL"]);
});

test('SQLCMD and SQL*Plus commands are statements of their own, with no semicolon', () => {
  const t = texts(':setvar DatabaseName app\n:on error exit\nALTER TABLE t ADD c int\n', 'mssql');
  assert.deepEqual(t, [':setvar DatabaseName app', ':on error exit', 'ALTER TABLE t ADD c int']);
  const o = parse('SET DEFINE OFF\nWHENEVER SQLERROR EXIT FAILURE\nPROMPT adding\n@other.sql\nALTER TABLE t ADD c NUMBER;\n', { dialect: 'oracle' }).statements;
  assert.deepEqual(o.map((s) => !!s.command), [true, true, true, true, false]);
});

test('Oracle: / closes a PL/SQL block, CREATE PROCEDURE and q-quoted strings; a block with no / is flagged', () => {
  const ok = "CREATE OR REPLACE PROCEDURE p IS\nBEGIN\n  NULL;\n  NULL;\nEND;\n/\nALTER TABLE t ADD c NUMBER;\nSELECT q'[it's; here]' FROM dual;\n";
  const s = parse(ok, { dialect: 'oracle' }).statements;
  assert.equal(s.length, 3);
  assert.ok(s[0].plsql && s[0].slash);
  const bad = parse('BEGIN\n  NULL;\nEND;\nALTER TABLE t ADD c NUMBER;\n', { dialect: 'oracle' }).statements;
  assert.deepEqual(bad.map((x) => [!!x.plsql, x.slash]), [[true, false], [false, undefined]]);
  const eof = parse('BEGIN\n  NULL;\nEND;\n', { dialect: 'oracle' }).statements;
  assert.equal(eof[0].slash, false);
});

test('Oracle: EXECUTE IMMEDIATE inside a block is also read as a statement', () => {
  const s = parse("BEGIN\n  EXECUTE IMMEDIATE 'ALTER TABLE t ADD c NUMBER';\nEND;\n/\n", { dialect: 'oracle' }).statements;
  assert.deepEqual(s.map((x) => !!x.inner), [false, true]);
  assert.equal(s[1].text, 'ALTER TABLE t ADD c NUMBER');
});

test('Db2: --#SET TERMINATOR changes the statement end, so compound statements keep their semicolons', () => {
  const sql = '--#SET TERMINATOR @\nCREATE TRIGGER x AFTER INSERT ON t FOR EACH ROW BEGIN ATOMIC SELECT 1 FROM sysibm.sysdummy1; END@\nALTER TABLE t DROP COLUMN c@\n';
  assert.equal(texts(sql, 'db2').length, 2);
  assert.equal(texts('ALTER TABLE a ADD c int; ALTER TABLE b ADD d int;', 'db2').length, 2);
});

test('names: Oracle, Db2 and SQL Server compare names without case, PostgreSQL and MySQL keep quoted case', () => {
  parse('SELECT 1;', { dialect: 'oracle' });
  assert.equal(name('"Orders"'), 'orders');
  assert.equal(name('app.ORDERS'), 'orders');
  assert.equal(name('[Orders]'), 'orders');
  parse('SELECT 1;', { dialect: 'postgres' });
  assert.equal(name('"Orders"'), 'Orders');
  assert.equal(name('app.ORDERS'), 'orders');
});

test('brackets nest when a list is split at top level', () => {
  assert.deepEqual(splitTopLevel("a int DEFAULT ARRAY[1,2], b int"), ['a int DEFAULT ARRAY[1,2]', 'b int']);
});
