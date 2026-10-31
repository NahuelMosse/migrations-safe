import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROFILES, detectRunner, profileOf, runnerFromMarkers, wrapsFile, wrapsFor } from '../skills/migrations-safe/scripts/lib/runners.mjs';
import { parse } from '../skills/migrations-safe/scripts/lib/parse.mjs';
import { findings, ids, put, scratch } from './helpers.mjs';

test('Oracle commits every DDL: no runner wraps a file there, so not-atomic and transaction-conflict follow', () => {
  assert.equal(wrapsFor(profileOf('flyway'), 'oracle'), false);
  assert.equal(wrapsFor(profileOf('flyway'), 'mssql'), true);
  assert.equal(wrapsFor(profileOf('django'), 'mysql'), false);
  assert.equal(wrapsFor(profileOf('django'), 'postgres'), true);
  assert.equal(wrapsFile(profileOf('flyway'), { statements: 3, dialect: 'oracle' }), false);
  const two = 'ALTER TABLE t ADD c NUMBER;\nALTER TABLE t ADD d NUMBER;\n';
  assert.ok(!ids(two, { dialect: 'oracle', runner: 'flyway' }).includes('not-atomic'), 'no transaction exists to advise, so no not-atomic');
  assert.ok(!ids(two.replaceAll('NUMBER', 'int'), { dialect: 'postgres', runner: 'flyway' }).includes('not-atomic'));
  assert.ok(!ids(`BEGIN;\n${two}COMMIT;\n`, { dialect: 'oracle', runner: 'flyway' }).includes('transaction-conflict'));
});

test('profiles for EF Core, DbUp and SqlPackage, and the separators each runner understands', () => {
  for (const id of ['efcore', 'dbup', 'sqlpackage']) assert.ok(PROFILES[id], id);
  assert.equal(PROFILES.efcore.generatesSql, true);
  assert.equal(PROFILES.dbup.wraps, false);
  assert.equal(PROFILES.dbup.order, 'lenient');
  assert.match(PROFILES.efcore.hint, /dotnet ef migrations script --idempotent/);
  assert.match(PROFILES.sqlpackage.hint, /Action:Script/);
  assert.deepEqual(PROFILES.flyway.separators, ['GO', '/']);
  assert.deepEqual(PROFILES.goose.separators, []);
  assert.deepEqual(PROFILES.golang_migrate?.separators ?? PROFILES['golang-migrate'].separators, []);
});

test('runners are detected from the project files and from the SQL they generated', (t) => {
  const dir = scratch(t);
  put(dir, '.git/HEAD', '');
  put(dir, 'ef/Migrations/20260101_AddNote.cs', '');
  put(dir, 'ef/Migrations/AppDbContextModelSnapshot.cs', '');
  put(dir, 'dacpac/App.sqlproj', '<Project/>');
  put(dir, 'dbup/Runner.csproj', '<PackageReference Include="dbup-sqlserver" Version="5" />');
  assert.equal(detectRunner(join(dir, 'ef/Migrations')).id, 'efcore');
  assert.equal(detectRunner(join(dir, 'dacpac')).id, 'sqlpackage');
  assert.equal(detectRunner(join(dir, 'dbup')).id, 'dbup');
  assert.equal(runnerFromMarkers(parse("INSERT INTO [__EFMigrationsHistory] VALUES (N'x', N'8');", { dialect: 'mssql' }).markers).id, 'efcore');
  assert.equal(runnerFromMarkers(parse('EXEC sp_rename N\'[tmp_ms_xx_t]\', N\'t\';\n', { dialect: 'mssql' }).markers).id, 'sqlpackage');
  assert.equal(runnerFromMarkers(parse(':setvar DatabaseName "app"\nGO\n', { dialect: 'mssql' }).markers).id, 'sqlpackage');
});

test('Liquibase formatted SQL: runInTransaction:false and a custom endDelimiter are read', () => {
  const p = parse('--liquibase formatted sql\n--changeset a:1 runInTransaction:false endDelimiter://\nCREATE PROCEDURE p AS BEGIN SELECT 1; END//\nALTER TABLE t ADD c int//\n', { dialect: 'mysql' });
  assert.ok(p.markers.noTransaction);
  assert.equal(p.statements.length, 2);
  assert.ok(p.markers.separators.has('terminator'));
});

test('a runner that does not split on GO, / or a terminator is warned about the file that uses them', () => {
  const go = 'ALTER TABLE t ADD c int NULL;\nGO\n';
  const hit = (runner) => findings(go, { dialect: 'mssql', runner }).filter((f) => f.rule === 'unsupported-separator');
  assert.equal(hit('goose').length, 1);
  assert.match(hit('golang-migrate')[0].message, /`GO`/);
  assert.equal(hit('flyway').length, 0);
  assert.equal(hit('raw').length, 0);
  assert.equal(findings('ALTER TABLE t ADD c int;\n', { dialect: 'mssql', runner: 'goose' }).filter((f) => f.rule === 'unsupported-separator').length, 0);
});
