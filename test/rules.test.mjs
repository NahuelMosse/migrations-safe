import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findings, ids } from './helpers.mjs';

const has = (sql, rule, ctx) => assert.ok(ids(sql, ctx).includes(rule), `expected ${rule}, got ${ids(sql, ctx)}`);
const lacks = (sql, rule, ctx) => assert.ok(!ids(sql, ctx).includes(rule), `unexpected ${rule}`);

test('ADD COLUMN is read as a whole: type arguments with commas do not cut the definition (H2)', () => {
  has('ALTER TABLE orders ADD COLUMN amount numeric(12,2) NOT NULL;', 'not-null-without-default');
  has('ALTER TABLE orders ADD COLUMN amount DECIMAL(65,30) NOT NULL;', 'not-null-without-default', { dialect: 'mysql' });
  const both = ids('ALTER TABLE orders ADD COLUMN a int NOT NULL, DROP COLUMN b;');
  assert.ok(both.includes('not-null-without-default') && both.includes('drop-column'));
  has('ALTER TABLE orders ADD COLUMN a int NOT NULL, ALTER COLUMN c SET NOT NULL;', 'not-null-without-default');
  has('ALTER TABLE orders ADD COLUMN a numeric(10,2) DEFAULT random();', 'volatile-default');
  has('ALTER TABLE orders ADD COLUMN u uuid DEFAULT gen_random_uuid(), ADD COLUMN p numeric(10,2);', 'volatile-default');
  lacks('ALTER TABLE orders ADD COLUMN a numeric(12,2) NOT NULL DEFAULT 0;', 'not-null-without-default');
  has('ALTER TABLE orders ADD COLUMN (a int NOT NULL, b int);', 'not-null-without-default', { dialect: 'mysql' });
});

test('volatile-default: now() does not rewrite since PG 11 and literals are not function calls (M2)', () => {
  lacks('ALTER TABLE t ADD COLUMN c timestamptz DEFAULT now();', 'volatile-default');
  lacks('ALTER TABLE t ADD COLUMN c timestamptz DEFAULT CURRENT_TIMESTAMP;', 'volatile-default');
  lacks("ALTER TABLE t ADD COLUMN c text DEFAULT 'random';", 'volatile-default');
  lacks("ALTER TABLE t ADD COLUMN c uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid;", 'volatile-default');
  lacks("ALTER TABLE t ADD COLUMN c text DEFAULT 'gen_random_uuid()';", 'volatile-default');
  has('ALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid();', 'volatile-default');
  has('ALTER TABLE t ADD COLUMN c double precision DEFAULT random();', 'volatile-default');
});

test('lock rules on existing tables are errors; hygiene rules stay warnings (H1)', () => {
  const level = (sql, rule, ctx) => findings(sql, ctx).find((f) => f.rule === rule)?.level;
  assert.equal(level('CREATE INDEX i ON orders (a);', 'index-without-concurrently'), 'error');
  assert.equal(level('ALTER TABLE orders ADD FOREIGN KEY (c) REFERENCES c (id);', 'constraint-without-not-valid'), 'error');
  assert.equal(level('ALTER TABLE orders ALTER COLUMN a SET NOT NULL;', 'set-not-null'), 'error');
  assert.equal(level('ALTER TABLE orders ADD UNIQUE (a);', 'constraint-builds-index'), 'error');
  assert.equal(level('DROP INDEX i;', 'drop-index-without-concurrently'), 'error');
  assert.equal(level('ALTER TABLE orders ADD COLUMN s serial;', 'rewriting-column'), 'error');
  assert.equal(level('ALTER TABLE orders ADD COLUMN c int;', 'missing-lock-timeout'), 'warning');
  assert.equal(level('ALTER TABLE t ADD COLUMN c int;', 'mysql-no-algorithm', { dialect: 'mysql' }), 'warning');
});

test('tables created in the same file or an earlier new migration are not "existing"', () => {
  lacks('CREATE TABLE t (a int); CREATE INDEX i ON t (a);', 'index-without-concurrently');
  lacks('CREATE INDEX i ON orders (a);', 'index-without-concurrently', { createdBefore: new Set(['orders']) });
  has('CREATE INDEX i ON orders (a);', 'index-without-concurrently', { createdBefore: new Set(['other']) });
  lacks('ALTER TABLE orders ADD COLUMN c int NOT NULL;', 'not-null-without-default', { createdBefore: new Set(['orders']) });
});

test('new data-loss and lock rules (M3)', () => {
  has('DROP SCHEMA reporting CASCADE;', 'drop-schema-cascade');
  lacks('DROP SCHEMA reporting;', 'drop-schema-cascade');
  has('DROP MATERIALIZED VIEW daily_totals;', 'drop-materialized-view');
  has('RENAME TABLE a TO b;', 'rename-table', { dialect: 'mysql' });
  has('ALTER TABLE a SET SCHEMA archive;', 'rename-table');
  has('UPDATE orders SET status = 1 WHERE status IS NULL;', 'update-all');
  lacks('UPDATE orders SET status = 1 WHERE id BETWEEN 1 AND 1000 AND status IS NULL;', 'update-all');
  has('DELETE FROM orders WHERE true;', 'delete-all');
  has('DELETE FROM orders WHERE 1 = 1;', 'delete-all');
  lacks("DELETE FROM orders WHERE note = 'where';", 'delete-all');
  has('TRUNCATE orders;', 'truncate');
  has("SET lock_timeout = '5s'; ALTER TABLE orders ADD CONSTRAINT pk PRIMARY KEY USING INDEX orders_idx;", 'primary-key-using-index');
  lacks("SET lock_timeout = '5s'; ALTER TABLE orders ALTER COLUMN id SET NOT NULL; ALTER TABLE orders ADD CONSTRAINT pk PRIMARY KEY USING INDEX orders_idx;", 'primary-key-using-index');
});

test('lock_timeout counts only when set before the first ALTER (M3, M4)', () => {
  has("ALTER TABLE orders ADD COLUMN c int; SET lock_timeout = '5s';", 'missing-lock-timeout');
  const late = findings("ALTER TABLE orders ADD COLUMN c int; SET lock_timeout = '5s';").find((f) => f.rule === 'missing-lock-timeout');
  assert.match(late.message, /after the first ALTER/);
  lacks("SET lock_timeout = '5s'; ALTER TABLE orders ADD COLUMN c int;", 'missing-lock-timeout');
  lacks("SET SESSION lock_timeout = '5s'; ALTER TABLE orders ADD COLUMN c int;", 'missing-lock-timeout');
  lacks("SET LOCAL lock_timeout = '5s'; ALTER TABLE orders ADD COLUMN c int;", 'missing-lock-timeout');
  lacks("SELECT set_config('lock_timeout', '5s', false); ALTER TABLE orders ADD COLUMN c int;", 'missing-lock-timeout');
});

test('SET NOT NULL after VALIDATE, or with its check dropped, is the recommended path (M4)', () => {
  has('ALTER TABLE orders ALTER COLUMN a SET NOT NULL;', 'set-not-null');
  lacks('ALTER TABLE orders VALIDATE CONSTRAINT orders_a_not_null; ALTER TABLE orders ALTER COLUMN a SET NOT NULL;', 'set-not-null');
  lacks('ALTER TABLE orders ALTER COLUMN a SET NOT NULL; ALTER TABLE orders DROP CONSTRAINT orders_a_not_null;', 'set-not-null');
});

test('a SQLite trigger with several statements is one statement (M4)', () => {
  const sql = `CREATE TRIGGER t AFTER INSERT ON a BEGIN
    UPDATE b SET n = n + 1;
    UPDATE c SET m = CASE WHEN 1 THEN 2 END;
  END;
  CREATE TABLE x (id int);`;
  lacks(sql, 'update-all', { dialect: 'sqlite' });
});

test('MySQL: MODIFY COLUMN and RENAME TABLE are found, no PostgreSQL advice (M1)', () => {
  const r = ids('ALTER TABLE users MODIFY COLUMN name varchar(10);', { dialect: 'mysql' });
  assert.ok(r.includes('change-column-type') && r.includes('mysql-no-algorithm'));
  assert.ok(!r.includes('missing-lock-timeout'));
  assert.ok(ids('ALTER TABLE users CHANGE old_name new_name varchar(10);', { dialect: 'mysql' }).includes('rename-column'));
  lacks('ALTER TABLE users MODIFY COLUMN name varchar(10), ALGORITHM=INPLACE, LOCK=NONE;', 'mysql-no-algorithm', { dialect: 'mysql' });
  has('ALTER TABLE users MODIFY COLUMN name varchar(10);', 'change-column-type');
});

test('dialect: directive, project dialect and syntax all override the PostgreSQL default (M1)', () => {
  has('-- migration-lint: dialect mysql\nALTER TABLE t DROP COLUMN c;', 'mysql-no-algorithm');
  has('ALTER TABLE t DROP COLUMN c;', 'mysql-no-algorithm', { projectDialect: 'mysql' });
  has('ALTER TABLE t MODIFY COLUMN c int;', 'mysql-no-algorithm');
  assert.ok(!ids('ALTER TABLE t ADD COLUMN c int;', { dialect: 'sqlite' }).includes('missing-lock-timeout'));
});

test('identifiers keep their written case in messages', () => {
  const f = findings('ALTER TABLE "Order" DROP COLUMN note;').find((x) => x.rule === 'drop-column');
  assert.match(f.message, /of Order:/);
});

test('rename-column does not fire on RENAME CONSTRAINT or RENAME INDEX', () => {
  lacks('ALTER TABLE t RENAME CONSTRAINT a TO b;', 'rename-column');
  lacks('ALTER TABLE t RENAME INDEX a TO b;', 'rename-column', { dialect: 'mysql' });
  has('ALTER TABLE t RENAME COLUMN a TO b;', 'rename-column');
  has('ALTER TABLE t RENAME a TO b;', 'rename-column');
});

test('Prisma RedefineTables: the Warnings comment and the rebuilt columns are findings (C2)', () => {
  const rebuild = (warnings = '') => `${warnings}
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_tasks" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "title" TEXT NOT NULL);
INSERT INTO "new_tasks" ("id", "title") SELECT "id", "title" FROM "tasks";
DROP TABLE "tasks";
ALTER TABLE "new_tasks" RENAME TO "tasks";
PRAGMA foreign_keys=ON;`;
  const warnings = `/*
  Warnings:

  - You are about to drop the column \`priority\` on the \`tasks\` table. All the data in the column will be lost.
  - A unique constraint covering the columns \`[title]\` on the table \`tasks\` will be added.

*/`;
  const f = findings(rebuild(warnings), { dialect: 'sqlite' }).filter((x) => x.rule === 'prisma-data-loss-warning');
  assert.deepEqual(f.map((x) => x.level), ['error', 'warning']);
  assert.match(f[0].message, /priority/);
  const schema = new Map([['tasks', new Set(['id', 'title', 'priority'])]]);
  const loses = findings(rebuild(), { dialect: 'sqlite', schema }).find((x) => x.rule === 'rebuild-drops-column');
  assert.match(loses.message, /priority/);
  const keeps = new Map([['tasks', new Set(['id', 'title'])]]);
  assert.deepEqual(ids(rebuild(), { dialect: 'sqlite', schema: keeps, runner: 'prisma' }), []);
});

test('a rebuild whose INSERT does not copy a column of the old table loses it (C2)', () => {
  const sql = `CREATE TABLE new_t (id INTEGER, a TEXT, b TEXT);
INSERT INTO new_t (id, a) SELECT id, a FROM t;
DROP TABLE t;
ALTER TABLE new_t RENAME TO t;`;
  const schema = new Map([['t', new Set(['id', 'a', 'b'])]]);
  const f = findings(sql, { dialect: 'sqlite', schema }).find((x) => x.rule === 'rebuild-drops-column');
  assert.match(f.message, /\bb\b/);
});

test('transactions: the runner wraps the file, so CONCURRENTLY needs its no-transaction marker (H5)', () => {
  const goose = (extra = '') => `${extra}-- +goose Up\nCREATE INDEX CONCURRENTLY i ON orders (a);\n-- +goose Down\nDROP INDEX CONCURRENTLY i;\n`;
  has(goose(), 'concurrently-in-transaction', { runner: 'goose' });
  lacks(goose('-- +goose NO TRANSACTION\n'), 'concurrently-in-transaction', { runner: 'goose' });
  const dbmate = (flag) => `-- migrate:up${flag}\nCREATE INDEX CONCURRENTLY i ON orders (a);\n-- migrate:down\nDROP INDEX i;\n`;
  has(dbmate(''), 'concurrently-in-transaction', { runner: 'dbmate' });
  lacks(dbmate(' transaction:false'), 'concurrently-in-transaction', { runner: 'dbmate' });
  lacks('-- atlas:txmode none\nCREATE INDEX CONCURRENTLY i ON orders (a);', 'concurrently-in-transaction', { runner: 'atlas' });
  has('CREATE INDEX CONCURRENTLY i ON orders (a);', 'concurrently-in-transaction', { runner: 'flyway' });
  // golang-migrate sends the file as one query: an implicit transaction only with several statements
  lacks('CREATE INDEX CONCURRENTLY i ON orders (a);', 'concurrently-in-transaction', { runner: 'golang-migrate' });
  has('CREATE INDEX CONCURRENTLY i ON orders (a); ANALYZE orders;', 'concurrently-in-transaction', { runner: 'golang-migrate' });
  lacks('CREATE INDEX CONCURRENTLY i ON orders (a); ANALYZE orders;', 'concurrently-in-transaction', { runner: 'raw' });
});

test('a wrapped file with its own BEGIN or PRAGMA foreign_keys conflicts with the runner (H5)', () => {
  const rebuild = `PRAGMA foreign_keys=OFF;
CREATE TABLE new_t (id INTEGER);
INSERT INTO new_t (id) SELECT id FROM t;
DROP TABLE t;
ALTER TABLE new_t RENAME TO t;
PRAGMA foreign_keys=ON;`;
  const pragma = findings(rebuild, { dialect: 'sqlite', runner: 'goose' }).filter((f) => f.rule === 'transaction-conflict');
  assert.equal(pragma.length, 2);
  assert.equal(pragma[0].level, 'error');
  assert.match(pragma[0].message, /defer_foreign_keys/);
  assert.deepEqual(ids(rebuild, { dialect: 'sqlite', runner: 'raw' }), ['not-atomic']);
  const begin = findings('BEGIN; CREATE TABLE a (id int); COMMIT;', { dialect: 'sqlite', runner: 'drizzle' }).find((f) => f.rule === 'transaction-conflict');
  assert.equal(begin.level, 'error');
  const pg = findings('BEGIN; CREATE TABLE a (id int); COMMIT;', { runner: 'flyway' }).find((f) => f.rule === 'transaction-conflict');
  assert.equal(pg.level, 'warning');
  lacks('BEGIN; CREATE TABLE a (id int); COMMIT;', 'transaction-conflict', { runner: 'raw' });
  lacks('BEGIN; CREATE TABLE a (id int); COMMIT;', 'transaction-conflict', { runner: 'golang-migrate' });
});

test('not-atomic does not apply when the runner wraps the file', () => {
  const sql = 'CREATE TABLE a (id int); CREATE TABLE b (id int);';
  has(sql, 'not-atomic', { runner: 'raw' });
  lacks(sql, 'not-atomic', { runner: 'flyway' });
  lacks(sql, 'not-atomic', { runner: 'golang-migrate' });
});

test('inside a table created by the same file nothing is data loss', () => {
  lacks('CREATE TABLE t (a int); UPDATE t SET a = 1;', 'update-all');
  lacks('CREATE TABLE t (a int); DROP TABLE t;', 'drop-table');
});
