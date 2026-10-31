import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findings } from './helpers.mjs';

const run = (sql, ctx = {}) => findings(sql, { dialect: 'db2', runner: 'flyway', ...ctx });
const rules = (sql, ctx) => run(`SET CURRENT LOCK TIMEOUT 5;\n${sql}`, ctx).map((f) => f.rule).sort();
const REORG = "CALL SYSPROC.ADMIN_CMD('REORG TABLE t');";

test('db2-reorg-pending: DROP COLUMN, SET/DROP NOT NULL and SET DATA TYPE need the REORG in the same migration', () => {
  assert.deepEqual(rules('ALTER TABLE t DROP COLUMN c;').filter((r) => r !== 'drop-column'), ['db2-reorg-pending']);
  assert.deepEqual(rules(`ALTER TABLE t DROP COLUMN c;\n${REORG}`).filter((r) => r !== 'drop-column'), ['db2-reorg-offline']);
  assert.deepEqual(rules('ALTER TABLE t ALTER COLUMN c SET NOT NULL;'), ['db2-reorg-pending']);
  assert.deepEqual(rules('ALTER TABLE t ALTER COLUMN c DROP NOT NULL;'), ['db2-reorg-pending']);
  assert.deepEqual(rules('ALTER TABLE t ALTER COLUMN c SET DATA TYPE BIGINT;').filter((r) => r !== 'change-column-type'), ['db2-reorg-pending']);
  assert.deepEqual(rules('ALTER TABLE t ALTER COLUMN c SET DATA TYPE VARCHAR(300);').filter((r) => r !== 'change-column-type'), []);
  assert.deepEqual(rules('ALTER TABLE t ADD COLUMN c INTEGER;'), []);
  assert.deepEqual(rules("ALTER TABLE a ALTER COLUMN c SET NOT NULL;\nCALL SYSPROC.ADMIN_CMD('REORG TABLE b');").sort(), ['db2-reorg-offline', 'db2-reorg-pending']);
  assert.deepEqual(rules('CREATE TABLE t (c INT);\nALTER TABLE t ALTER COLUMN c SET NOT NULL;'), []);
});

test('db2-reorg-offline: a classic REORG blocks writers; INPLACE does not', () => {
  assert.deepEqual(rules("CALL SYSPROC.ADMIN_CMD('REORG TABLE t');"), ['db2-reorg-offline']);
  assert.deepEqual(rules('REORG TABLE t;'), ['db2-reorg-offline']);
  assert.deepEqual(rules("CALL SYSPROC.ADMIN_CMD('REORG TABLE t INPLACE ALLOW WRITE ACCESS');"), []);
});

test('db2-reorg-limit: the fourth unit of work with a REORG-recommended operation on a table fails', () => {
  const op = (n) => `ALTER TABLE t ALTER COLUMN c${n} SET NOT NULL;`;
  const four = [1, 2, 3, 4].map(op).join('\n');
  const limit = (sql, ctx) => rules(sql, ctx).filter((r) => r === 'db2-reorg-limit').length;
  // a runner that does not wrap the file runs each statement as its own unit of work
  assert.equal(limit(four, { runner: 'raw' }), 1);
  assert.equal(limit([1, 2, 3].map(op).join('\n'), { runner: 'raw' }), 0);
  // wrapped in one unit of work by the runner, they count once
  assert.equal(limit(four, { runner: 'flyway' }), 0);
  assert.equal(limit(`${[1, 2, 3].map(op).join('\n')}\n${REORG}\n${op(4)}`, { runner: 'raw' }), 0);
});

test('db2-constraint-check: FK and CHECK evaluate the rows at once unless NOT ENFORCED', () => {
  assert.deepEqual(rules('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (u) REFERENCES users (id);'), ['db2-constraint-check']);
  assert.deepEqual(rules('ALTER TABLE t ADD CONSTRAINT ck CHECK (a > 0);'), ['db2-constraint-check']);
  assert.deepEqual(rules('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (u) REFERENCES users (id) NOT ENFORCED;'), []);
  assert.deepEqual(rules('CREATE TABLE t (u INT);\nALTER TABLE t ADD CONSTRAINT ck CHECK (u > 0);'), []);
});

test('db2-lock-timeout: DDL on an existing table needs SET CURRENT LOCK TIMEOUT first', () => {
  const at = (sql) => run(sql).map((f) => f.rule);
  assert.deepEqual(at('ALTER TABLE t ADD COLUMN c INTEGER;'), ['db2-lock-timeout']);
  assert.deepEqual(at('SET CURRENT LOCK TIMEOUT 5;\nALTER TABLE t ADD COLUMN c INTEGER;'), []);
  assert.deepEqual(at('SET CURRENT LOCK TIMEOUT WAIT;\nALTER TABLE t ADD COLUMN c INTEGER;'), ['db2-lock-timeout']);
  assert.deepEqual(at('ALTER TABLE t ADD COLUMN c INTEGER;\nSET CURRENT LOCK TIMEOUT 5;'), ['db2-lock-timeout']);
  assert.match(run('ALTER TABLE t ADD COLUMN c INTEGER;')[0].message, /defaults to -1/);
});

test('Db2 files are recognised by their own statements, not by GENERATED ... IDENTITY', () => {
  assert.deepEqual(findings('SET CURRENT LOCK TIMEOUT 5;\nALTER TABLE t ADD COLUMN c INTEGER;\n').map((f) => f.rule).filter((r) => r !== 'not-atomic'), []);
  assert.deepEqual(findings('ALTER TABLE t ADD COLUMN c INTEGER;\nCALL SYSPROC.ADMIN_CMD(\'RUNSTATS ON TABLE t\');\n').map((f) => f.rule).includes('db2-lock-timeout'), true);
  assert.deepEqual(findings('ALTER TABLE t ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY;\n').filter((f) => f.rule.startsWith('db2-')), []);
});
