import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DIALECTS, sniffDialect } from '../skills/migrations-safe/scripts/lib/runners.mjs';
import { DEFAULT_EDITION, parseServerVersion, projectServerVersion, serverVersionOrThrow, versionAtLeast } from '../skills/migrations-safe/scripts/lib/server-version.mjs';
import { lintCli, put, scratch } from './helpers.mjs';

test('the dialect registry lists the six dialects', () => {
  assert.deepEqual(DIALECTS, ['postgres', 'sqlite', 'mysql', 'mssql', 'oracle', 'db2']);
});

test('sniffing: strong markers of SQL Server, Oracle and Db2', () => {
  assert.equal(sniffDialect('ALTER TABLE [dbo].[orders] ADD [note] nvarchar(10) NULL;\nGO\n'), 'mssql');
  assert.equal(sniffDialect("EXEC sp_rename 'orders.note', 'memo', 'COLUMN';"), 'mssql');
  assert.equal(sniffDialect('CREATE TABLE t (id int);\nGO 3\n'), 'mssql');
  assert.equal(sniffDialect('ALTER TABLE orders ADD note VARCHAR2(10);'), 'oracle');
  assert.equal(sniffDialect("BEGIN\n  EXECUTE IMMEDIATE 'DROP TABLE x';\nEND;\n/\n"), 'oracle');
  assert.equal(sniffDialect('ALTER TABLE t MODIFY (note VARCHAR(20));'), 'oracle');
  assert.equal(sniffDialect('--#SET TERMINATOR @\nALTER TABLE t DROP COLUMN c@\n'), 'db2');
  assert.equal(sniffDialect("CALL SYSPROC.ADMIN_CMD('REORG TABLE t');"), 'db2');
});

test('sniffing: PostgreSQL syntax that looks like another product stays PostgreSQL', () => {
  assert.equal(sniffDialect('ALTER TABLE t ADD COLUMN tags text[];'), 'postgres');
  assert.equal(sniffDialect('SELECT a[1], ARRAY[1,2] FROM t;'), 'postgres');
  assert.equal(sniffDialect("INSERT INTO t VALUES ('[x]', 'GO');"), 'postgres');
  assert.equal(sniffDialect('ALTER TABLE t ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;'), 'postgres');
  assert.equal(sniffDialect('-- GO\n-- [dbo]\nSELECT 1;'), 'postgres');
});

test('server versions: SQL Server by year or major, Oracle and Db2 by release', () => {
  assert.equal(parseServerVersion('mssql', '2022-latest').major, 2022);
  assert.equal(parseServerVersion('mssql', '2019-CU12-ubuntu-20.04').major, 2019);
  assert.equal(parseServerVersion('mssql', '15.0.2000').major, 2019);
  assert.equal(parseServerVersion('mssql', 'banana'), null);
  assert.equal(parseServerVersion('oracle', '23ai').major, 23);
  assert.equal(parseServerVersion('oracle', '12.1').minor, 1);
  assert.equal(parseServerVersion('oracle', '19-slim').major, 19);
  assert.equal(parseServerVersion('db2', '11.5.9.0').minor, 5);
  assert.equal(parseServerVersion('db2', 'latest'), null);
  assert.ok(versionAtLeast(parseServerVersion('oracle', '12'), 12, 1));
  assert.ok(!versionAtLeast(parseServerVersion('oracle', '11.2'), 12, 1));
  assert.throws(() => serverVersionOrThrow('mssql', 'nope'), /unknown SQL Server version/);
  assert.deepEqual(DEFAULT_EDITION, { mssql: 'standard', oracle: 'se2' });
});

test('the server version of a project is read from its compose file, per dialect', (t) => {
  const dir = scratch(t);
  put(dir, '.git/HEAD', '');
  put(dir, 'docker-compose.yml', 'services:\n  a:\n    image: mcr.microsoft.com/mssql/server:2019-latest\n  b:\n    image: gvenzl/oracle-free:23-slim\n  c:\n    image: icr.io/db2_community/db2:11.5.9.0\n');
  const sub = join(dir, 'db');
  put(dir, 'db/0001.sql', 'SELECT 1;');
  assert.equal(projectServerVersion(sub, 'mssql').version.major, 2019);
  assert.equal(projectServerVersion(sub, 'oracle').version.major, 23);
  assert.equal(projectServerVersion(sub, 'db2').version.label, 'Db2 LUW 11.5');
  assert.equal(projectServerVersion(sub, 'mysql'), null);
  assert.equal(projectServerVersion(sub, 'postgres'), null);
});

test('lint-cli: --server-version and --edition are validated and appear in the notes', (t) => {
  const dir = scratch(t);
  const f = put(dir, '0001.sql', '-- migration-lint: dialect mssql\nSELECT 1;\n');
  const run = (...extra) => lintCli([f, '--format', 'json', ...extra]);
  const notes = (r) => JSON.parse(r.out).notes.join('\n');
  assert.match(notes(run()), /SQL Server rules assume SQL Server 2022, standard edition \(default/);
  assert.match(notes(run('--server-version', '2016', '--edition', 'enterprise')), /SQL Server 2016, enterprise edition \(--edition\).*\(--server-version\)/);
  assert.equal(run('--edition', 'se2').code, 2);
  assert.match(run('--server-version', 'nope').out, /unknown SQL Server version/);
  const pg = put(dir, 'pg/0001.sql', 'SELECT 1;\n');
  const r = lintCli([pg, '--format', 'json', '--edition', 'enterprise']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--edition has no meaning for postgres/);
  assert.match(lintCli(['--help']).out, /--server-version <v>[\s\S]*--edition <e>/);
});
