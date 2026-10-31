import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServerVersion } from '../skills/migrations-safe/scripts/lib/server-version.mjs';
import { findings } from './helpers.mjs';

const run = (sql, { edition = 'se2', version = '19', ...ctx } = {}) => findings(sql, {
  dialect: 'oracle', runner: 'flyway', edition, serverVersion: parseServerVersion('oracle', version), ...ctx,
});
const rules = (sql, ctx) => run(`ALTER SESSION SET DDL_LOCK_TIMEOUT = 30;\n${sql}`, ctx).map((f) => f.rule).sort();

test('oracle-add-column-default: a nullable column with a default rewrites rows before 12.1', () => {
  const add = 'ALTER TABLE t ADD (c NUMBER DEFAULT 0);';
  assert.deepEqual(rules(add, { version: '11.2' }), ['oracle-add-column-default']);
  assert.deepEqual(rules(add, { version: '12.1' }), []);
  assert.deepEqual(rules(add), []);
  assert.deepEqual(rules('ALTER TABLE t ADD (c NUMBER DEFAULT 0 NOT NULL);', { version: '11.2' }), []);
  assert.deepEqual(rules('ALTER TABLE t ADD c NUMBER DEFAULT 0;', { version: '11.2' }), ['oracle-add-column-default']);
  assert.deepEqual(rules('CREATE TABLE t (id NUMBER); ALTER TABLE t ADD (c NUMBER DEFAULT 0);', { version: '11.2' }).filter((r) => r !== 'not-atomic'), []);
});

test('oracle-ddl-lock-timeout: no queueing, so DDL on a busy table fails with ORA-00054 unless DDL_LOCK_TIMEOUT is set', () => {
  const at = (sql) => run(sql).map((f) => f.rule);
  assert.deepEqual(at('ALTER TABLE t ADD (c NUMBER);'), ['oracle-ddl-lock-timeout']);
  assert.deepEqual(at('ALTER SESSION SET DDL_LOCK_TIMEOUT = 30;\nALTER TABLE t ADD (c NUMBER);'), []);
  assert.deepEqual(at('ALTER SESSION SET DDL_LOCK_TIMEOUT = 0;\nALTER TABLE t ADD (c NUMBER);'), ['oracle-ddl-lock-timeout']);
  assert.deepEqual(at('ALTER TABLE t ADD (c NUMBER);\nALTER SESSION SET DDL_LOCK_TIMEOUT = 30;'), ['oracle-ddl-lock-timeout']);
  assert.match(run('ALTER TABLE t ADD (c NUMBER);')[0].message, /ORA-00054/);
});

test('oracle-ddl-commits-dml: pending DML is committed by the next DDL', () => {
  assert.deepEqual(rules('UPDATE t SET a = 1 WHERE id = 1;\nALTER TABLE t ADD (c NUMBER);').filter((r) => r !== 'not-atomic'), ['oracle-ddl-commits-dml']);
  assert.deepEqual(rules('UPDATE t SET a = 1 WHERE id = 1;\nCOMMIT;\nALTER TABLE t ADD (c NUMBER);'), []);
  assert.deepEqual(rules('CREATE TABLE n (id NUMBER);\nINSERT INTO n VALUES (1);\nCREATE TABLE m (id NUMBER);').includes('oracle-ddl-commits-dml'), true);
  assert.deepEqual(rules('INSERT INTO n VALUES (1);\nCOMMIT;').includes('oracle-ddl-commits-dml'), false);
});

test('oracle-index-not-online and oracle-online-unsupported-edition', () => {
  assert.deepEqual(rules('CREATE INDEX ix ON t (c);', { edition: 'ee' }), ['oracle-index-not-online']);
  assert.deepEqual(rules('CREATE INDEX ix ON t (c) ONLINE;', { edition: 'ee' }), []);
  assert.deepEqual(rules('CREATE INDEX ix ON t (c) ONLINE;'), ['oracle-online-unsupported-edition']);
  assert.deepEqual(rules('ALTER INDEX ix REBUILD;', { edition: 'ee' }), ['oracle-index-not-online']);
  assert.deepEqual(rules('ALTER INDEX ix REBUILD ONLINE;'), ['oracle-online-unsupported-edition']);
  assert.deepEqual(rules('ALTER TABLE t MOVE ONLINE;'), ['oracle-online-unsupported-edition']);
  assert.deepEqual(rules('ALTER TABLE t MOVE ONLINE;', { edition: 'ee' }), []);
  assert.deepEqual(rules("BEGIN\n  DBMS_REDEFINITION.START_REDEF_TABLE('A', 'T', 'T2');\nEND;\n/").includes('oracle-online-unsupported-edition'), true);
  assert.deepEqual(rules("BEGIN\n  DBMS_REDEFINITION.START_REDEF_TABLE('A', 'T', 'T2');\nEND;\n/", { edition: 'ee' }).includes('oracle-online-unsupported-edition'), false);
  assert.deepEqual(rules('CREATE TABLE t (id NUMBER); CREATE INDEX ix ON t (id);').filter((r) => r !== 'not-atomic'), []);
});

test('oracle-constraint-validate: FK and CHECK need ENABLE NOVALIDATE and a separate VALIDATE', () => {
  assert.deepEqual(rules('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (u) REFERENCES users (id);'), ['oracle-constraint-validate']);
  assert.deepEqual(rules('ALTER TABLE t ADD CONSTRAINT ck CHECK (a > 0);'), ['oracle-constraint-validate']);
  assert.deepEqual(rules('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (u) REFERENCES users (id) ENABLE NOVALIDATE;'), []);
  assert.deepEqual(rules('ALTER TABLE t MODIFY CONSTRAINT fk VALIDATE;'), []);
});

test('oracle-drop-column-rewrites: DROP COLUMN warns about the rewrite on top of drop-column; SET UNUSED is a drop too', () => {
  assert.deepEqual(rules('ALTER TABLE t DROP COLUMN c;'), ['drop-column', 'oracle-drop-column-rewrites']);
  assert.deepEqual(rules('ALTER TABLE t DROP (a, b);'), ['drop-column', 'oracle-drop-column-rewrites']);
  assert.deepEqual(rules('ALTER TABLE t SET UNUSED (c);'), ['drop-column']);
});

test('oracle-missing-slash: a block without / swallows what follows', () => {
  assert.deepEqual(run('BEGIN\n  NULL;\nEND;\n/\n').map((f) => f.rule), []);
  assert.deepEqual(run('BEGIN\n  NULL;\nEND;\n').map((f) => f.rule), ['oracle-missing-slash']);
  assert.deepEqual(run('CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW\nBEGIN\n  NULL;\nEND;\n').map((f) => f.rule), ['oracle-missing-slash']);
  assert.deepEqual(run('CREATE OR REPLACE PROCEDURE p IS\nBEGIN\n  NULL;\nEND;\n/\n').map((f) => f.rule), []);
});

test('Oracle commits every DDL: BEGIN is a PL/SQL block, so several DDL statements are not atomic', () => {
  const r = run('ALTER SESSION SET DDL_LOCK_TIMEOUT = 30;\nALTER TABLE t ADD (a NUMBER);\nALTER TABLE t ADD (b NUMBER);\n').map((f) => f.rule);
  assert.deepEqual(r, ['not-atomic']);
});

test('names compare without case: "Orders" and ORDERS are the table created in this file', () => {
  assert.deepEqual(rules('CREATE TABLE "Orders" (id NUMBER);\nCREATE INDEX ix ON ORDERS (id);').filter((r) => r !== 'not-atomic'), []);
});
