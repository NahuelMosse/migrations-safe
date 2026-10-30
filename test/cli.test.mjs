import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLintCli } from '../skills/migrations-safe/scripts/lib/lint-cli.mjs';
import { LINT, REHEARSE, SKILL, lintCli, node, put, rehearseCli, scratch } from './helpers.mjs';

const BAD = 'ALTER TABLE orders DROP COLUMN note;\n';

test('--help exits 0 and prints usage; unknown options and bad values exit 2', () => {
  assert.equal(lintCli(['--help']).code, 0);
  assert.match(lintCli(['--help']).out, /usage: migration-lint/);
  for (const args of [['--nope', 'x.sql'], ['--dialect', 'oracle', 'x.sql'], ['--runner', 'rails', 'x.sql'], ['--format', 'xml', 'x.sql'], ['--fail-on', 'loud', 'x.sql'], []]) {
    const r = lintCli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /could not run/);
  }
  assert.equal(rehearseCli(['--help']).code, 0);
  assert.equal(rehearseCli(['--nope']).code, 2);
});

test('exit 1 on errors, 0 when clean, and exit 2 for a file that does not exist', (t) => {
  const dir = scratch(t);
  put(dir, 'bad.sql', BAD);
  put(dir, 'ok.sql', '-- migration-lint: irreversible -- test\nCREATE TABLE a (id int);\n');
  assert.equal(lintCli([join(dir, 'bad.sql')]).code, 1);
  assert.equal(lintCli([join(dir, 'ok.sql')]).code, 0);
  assert.equal(lintCli([join(dir, 'missing.sql')]).code, 2);
});

test('0 files linted is exit 2, never a pass', (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'empty'));
  const r = lintCli([join(dir, 'empty')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /nothing was checked/);
  put(dir, 'only/0001_x.down.sql', 'DROP TABLE x;');
  assert.equal(lintCli([join(dir, 'only')]).code, 2);
});

test('a project whose runner generates SQL at run time gets a hint, not a silent pass', (t) => {
  const dir = scratch(t);
  put(dir, 'manage.py', '');
  put(dir, 'app/migrations/0001_initial.py', '');
  const r = lintCli([join(dir, 'app', 'migrations')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Django generates its SQL at run time/);
  assert.match(r.err, /sqlmigrate/);
});

test('stdin: "-" lints piped SQL', () => {
  const r = lintCli(['-', '--format', 'json'], { input: BAD });
  assert.equal(r.code, 1);
  const json = JSON.parse(r.out);
  assert.equal(json.findings[0].file, '<stdin>');
  assert.equal(json.files, 1);
  assert.equal(lintCli(['-'], { input: 'CREATE TABLE a (id int);' }).code, 0);
  assert.equal(lintCli(['-', '--runner', 'django', '--dialect', 'postgres', '--format', 'json'], { input: 'CREATE INDEX i ON orders (a);' }).code, 1);
});

test('--fail-on: warning, error and rule ids; --strict is --fail-on warning', (t) => {
  const dir = scratch(t);
  const file = put(dir, 'w.sql', 'CREATE TABLE a (id int);\n');
  assert.equal(lintCli([file]).code, 0);
  assert.equal(lintCli([file, '--fail-on', 'warning']).code, 1);
  assert.equal(lintCli([file, '--strict']).code, 1);
  assert.equal(lintCli([file, '--fail-on', 'missing-down']).code, 1);
  assert.equal(lintCli([file, '--fail-on', 'truncate']).code, 0);
  assert.equal(lintCli([file, '--runner', 'prisma', '--fail-on', 'warning']).code, 0);
});

test('JSON output has schemaVersion 1; failures are JSON too under --format json', (t) => {
  const dir = scratch(t);
  const ok = JSON.parse(lintCli([put(dir, 'a.sql', BAD), '--format', 'json']).out);
  assert.equal(ok.schemaVersion, 1);
  assert.equal(typeof ok.errors, 'number');
  assert.ok(Array.isArray(ok.findings));
  const failed = lintCli(['--format', 'json', '--bogus', 'x.sql']);
  assert.equal(failed.code, 2);
  const err = JSON.parse(failed.out);
  assert.equal(err.schemaVersion, 1);
  assert.equal(err.exitCode, 2);
  assert.match(err.error.message, /unknown option/);
  assert.equal(JSON.parse(lintCli(['--json', join(dir, 'missing.sql')]).out).exitCode, 2);
});

test('SARIF 2.1.0 output carries rule, level and location', (t) => {
  const dir = scratch(t);
  const file = put(dir, 'a.sql', BAD);
  const sarif = JSON.parse(lintCli([file, '--format', 'sarif']).out);
  assert.equal(sarif.version, '2.1.0');
  const [result] = sarif.runs[0].results;
  assert.equal(result.ruleId, 'drop-column');
  assert.equal(result.level, 'error');
  assert.equal(result.locations[0].physicalLocation.region.startLine, 1);
  assert.ok(sarif.runs[0].tool.driver.rules.some((r) => r.id === 'drop-column'));
  const failed = JSON.parse(lintCli(['--format', 'sarif', '--bogus', 'x']).out);
  assert.equal(failed.runs[0].invocations[0].executionSuccessful, false);
});

test('GitHub workflow annotations', (t) => {
  const dir = scratch(t);
  const file = put(dir, 'a.sql', BAD);
  const r = lintCli([file, '--format', 'github']);
  assert.match(r.out, /^::error file=.*a\.sql,line=1,title=drop-column::drops a column/m);
  assert.match(lintCli(['--format', 'github', '--bogus', 'x']).out, /^::error title=migration-lint could not run::/);
});

test('an unexpected crash is exit 2, not 1', () => {
  const lines = [];
  const code = runLintCli(['-h'], { out: () => { throw new Error('boom'); }, err: (s) => lines.push(s) });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /unexpected error: Error: boom/);
});

test('the CLIs run when invoked through a symlink or junction', (t) => {
  const dir = scratch(t);
  const link = join(dir, 'linked-scripts');
  symlinkSync(join(SKILL, 'scripts'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const bad = put(dir, 'bad.sql', BAD);
  const lint = node(join(link, 'migration-lint.mjs'), [bad]);
  assert.equal(lint.code, 1, lint.err);
  assert.match(lint.out, /drop-column/);
  assert.equal(node(join(link, 'rehearse-sqlite.mjs'), ['--help']).code, 0);
  assert.match(node(join(link, 'rehearse-sqlite.mjs'), ['--help']).out, /usage: rehearse-sqlite/);

  // a link to the script file itself (needs privileges on Windows)
  try {
    symlinkSync(LINT, join(dir, 'lint-link.mjs'), 'file');
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    return;
  }
  assert.equal(node(join(dir, 'lint-link.mjs'), [bad]).code, 1);
  symlinkSync(REHEARSE, join(dir, 'rehearse-link.mjs'), 'file');
  assert.equal(node(join(dir, 'rehearse-link.mjs'), ['--help']).code, 0);
});

test('files named *_down.sql that are not undo files are linted (isDownFile)', (t) => {
  const dir = scratch(t);
  put(dir, '0001_scale_down.sql', BAD);
  put(dir, '0002_tear_down.sql', BAD);
  put(dir, '0003_x.down.sql', BAD);
  put(dir, 'U4__undo.sql', BAD);
  const json = JSON.parse(lintCli([dir, '--format', 'json']).out);
  assert.equal(json.files, 2);
});

test('missing-down: only for runners that have downs', (t) => {
  const prisma = scratch(t);
  put(prisma, 'prisma/schema.prisma', '');
  put(prisma, 'prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n');
  put(prisma, 'prisma/migrations/20260301000000_a/migration.sql', 'CREATE TABLE a (id int);\n');
  const p = JSON.parse(lintCli([join(prisma, 'prisma/migrations'), '--format', 'json']).out);
  assert.deepEqual(p.findings.map((f) => f.rule), []);

  const raw = scratch(t);
  put(raw, '0001_a.sql', 'CREATE TABLE a (id int);\n');
  assert.deepEqual(JSON.parse(lintCli([raw, '--format', 'json']).out).findings.map((f) => f.rule), ['missing-down']);
  assert.deepEqual(JSON.parse(lintCli([raw, '--runner', 'flyway', '--format', 'json']).out).findings.map((f) => f.rule), []);
});

test('Prisma project: a CREATE INDEX on an existing table fails the run with no missing-down noise', (t) => {
  const dir = scratch(t);
  put(dir, 'prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n');
  put(dir, 'prisma/migrations/20260301000000_init/migration.sql', 'CREATE TABLE orders (id int);\n');
  put(dir, 'prisma/migrations/20260302000000_idx/migration.sql', 'CREATE INDEX orders_id_idx ON orders (id);\n');
  const r = lintCli([join(dir, 'prisma/migrations'), '--format', 'json']);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).findings.map((f) => f.rule), ['index-without-concurrently']);
});

test('dialect comes from migration_lock.toml and from the syntax', (t) => {
  const dir = scratch(t);
  put(dir, 'prisma/migrations/migration_lock.toml', 'provider = "mysql"\n');
  put(dir, 'prisma/migrations/20260301000000_a/migration.sql', 'ALTER TABLE t DROP COLUMN c;\n');
  const rules = (args) => JSON.parse(lintCli([...args, '--format', 'json']).out).findings.map((f) => f.rule);
  assert.ok(rules([join(dir, 'prisma/migrations')]).includes('mysql-no-algorithm'));
  assert.ok(!rules([join(dir, 'prisma/migrations'), '--dialect', 'postgres']).includes('mysql-no-algorithm'));
  const loose = put(dir, 'loose/x.sql', 'ALTER TABLE t MODIFY COLUMN c int;\n');
  assert.ok(rules([loose, '--runner', 'raw']).includes('mysql-no-algorithm'));
  const drizzle = scratch(t);
  put(drizzle, 'drizzle.config.ts', "export default { dialect: 'sqlite', out: './drizzle' };\n");
  put(drizzle, 'drizzle/0000_a.sql', 'ALTER TABLE t ADD COLUMN c int;\n');
  assert.ok(!rules([join(drizzle, 'drizzle')]).includes('missing-lock-timeout'));
});

test('a SQLite rebuild in a folder is compared with the table as earlier migrations left it', (t) => {
  const dir = scratch(t);
  put(dir, 'prisma/migrations/migration_lock.toml', 'provider = "sqlite"\n');
  put(dir, 'prisma/migrations/20260301000000_init/migration.sql', 'CREATE TABLE "tasks" ("id" INTEGER NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "priority" INTEGER);\n');
  put(dir, 'prisma/migrations/20260302000000_redefine/migration.sql', [
    'PRAGMA foreign_keys=OFF;',
    'CREATE TABLE "new_tasks" ("id" INTEGER NOT NULL PRIMARY KEY, "title" TEXT NOT NULL);',
    'INSERT INTO "new_tasks" ("id", "title") SELECT "id", "title" FROM "tasks";',
    'DROP TABLE "tasks";',
    'ALTER TABLE "new_tasks" RENAME TO "tasks";',
    'PRAGMA foreign_keys=ON;', ''].join('\n'));
  const r = lintCli([join(dir, 'prisma/migrations'), '--format', 'json']);
  assert.equal(r.code, 1);
  const f = JSON.parse(r.out).findings;
  assert.deepEqual(f.map((x) => x.rule).sort(), ['rebuild-drops-column', 'transaction-conflict']);
  assert.match(f.find((x) => x.rule === 'rebuild-drops-column').message, /priority/);
  const withSchema = lintCli([join(dir, 'prisma/migrations/20260302000000_redefine/migration.sql'), '--schema', join(dir, 'prisma/migrations/20260301000000_init'), '--format', 'json']);
  assert.equal(withSchema.code, 1);
});

test('empty stdin is exit 2, not a pass', () => {
  for (const input of ['', '  \n', '-- only a comment\n']) {
    const r = lintCli(['-', '--runner', 'django'], { input });
    assert.equal(r.code, 2, JSON.stringify(input));
    assert.match(r.err, /stdin held no SQL statements/);
  }
});

test('an invalid --fail-on is a usage error, not a stack trace', () => {
  for (const value of ['loud', ',', 'warning,nope']) {
    const r = lintCli(['-', '--fail-on', value], { input: 'SELECT 1;' });
    assert.equal(r.code, 2, value);
    assert.match(r.err, /^could not run: --fail-on/);
    assert.ok(!/\n\s+at /.test(r.err), 'no stack trace');
  }
});

test('--schema applies to stdin as well', (t) => {
  const dir = scratch(t);
  const schema = put(dir, 'schema.sql', 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, priority INTEGER);\n');
  const rebuild = [
    'CREATE TABLE new_tasks (id INTEGER PRIMARY KEY, title TEXT);',
    'INSERT INTO new_tasks (id, title) SELECT id, title FROM tasks;',
    'DROP TABLE tasks;',
    'ALTER TABLE new_tasks RENAME TO tasks;', ''].join('\n');
  const r = lintCli(['-', '--dialect', 'sqlite', '--schema', schema, '--format', 'json'], { input: rebuild });
  assert.ok(JSON.parse(r.out).findings.some((f) => f.rule === 'rebuild-drops-column'));
  const without = lintCli(['-', '--dialect', 'sqlite', '--format', 'json'], { input: rebuild });
  assert.ok(!JSON.parse(without.out).findings.some((f) => f.rule === 'rebuild-drops-column'));
});

test('goose and dbmate markers on stdin select the runner, so no-transaction files pass', () => {
  const index = 'CREATE INDEX CONCURRENTLY i ON orders (a);\n';
  const rules = (sql) => JSON.parse(lintCli(['-', '--format', 'json'], { input: sql }).out).findings.map((f) => f.rule);
  assert.ok(rules(`-- +goose Up\n${index}`).includes('concurrently-in-transaction'));
  assert.ok(!rules(`-- +goose NO TRANSACTION\n-- +goose Up\n${index}-- +goose Down\nDROP INDEX i;\n`).includes('concurrently-in-transaction'));
  assert.ok(rules(`-- migrate:up\n${index}-- migrate:down\nDROP INDEX i;\n`).includes('concurrently-in-transaction'));
  assert.ok(!rules(`-- migrate:up transaction:false\n${index}-- migrate:down\nDROP INDEX i;\n`).includes('concurrently-in-transaction'));
  assert.ok(!rules(`-- +goose Up\n${index}`).includes('missing-down'), 'no missing-down for stdin');
});

test('Liquibase formatted SQL: a --rollback line is the down', (t) => {
  const dir = scratch(t);
  put(dir, 'with.sql', '--liquibase formatted sql\n--changeset ana:1\nCREATE TABLE a (id int);\n--rollback DROP TABLE a;\n');
  put(dir, 'without.sql', '--liquibase formatted sql\n--changeset ana:2\nCREATE TABLE b (id int);\n');
  const f = JSON.parse(lintCli([dir, '--format', 'json']).out).findings;
  assert.deepEqual(f.map((x) => `${x.rule}:${x.file.split('/').at(-1)}`), ['missing-down:without.sql']);
});

test('Flyway reads executeInTransaction=false from the .conf next to a script', (t) => {
  const dir = scratch(t);
  put(dir, 'flyway.conf', '');
  const sql = 'CREATE INDEX CONCURRENTLY a ON orders (x);\nANALYZE orders;\n';
  put(dir, 'sql/V1__a.sql', sql);
  put(dir, 'sql/V2__b.sql', sql);
  put(dir, 'sql/V2__b.sql.conf', 'executeInTransaction=false\n');
  const f = JSON.parse(lintCli([join(dir, 'sql'), '--format', 'json']).out).findings;
  assert.deepEqual(f.map((x) => `${x.rule}:${x.file.split('/').at(-1)}`), ['concurrently-in-transaction:V1__a.sql']);
});
