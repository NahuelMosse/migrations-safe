import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseMysqlVersion, projectMysqlVersion } from '../skills/migrations-safe/scripts/lib/mysql.mjs';
import { RULES } from '../skills/migrations-safe/scripts/lib/rules.mjs';
import { findings, ids, lintCli, put, scratch } from './helpers.mjs';

const my = (sql, ctx = {}) => ids(sql, { dialect: 'mysql', ...ctx });
const ver = (v) => ({ mysqlVersion: parseMysqlVersion(v) });
const SET = 'SET SESSION lock_wait_timeout = 5;\n';
const has = (sql, rule, ctx) => assert.ok(my(sql, ctx).includes(rule), `expected ${rule}, got ${my(sql, ctx)}`);
const lacks = (sql, rule, ctx) => assert.ok(!my(sql, ctx).includes(rule), `unexpected ${rule}`);

test('versions parse with flavor, optional patch and any separator', () => {
  assert.deepEqual(parseMysqlVersion('8.0.28'), { flavor: 'mysql', major: 8, minor: 0, patch: 28, label: 'MySQL 8.0.28' });
  assert.equal(parseMysqlVersion('mariadb:10.6').label, 'MariaDB 10.6');
  assert.equal(parseMysqlVersion('mariadb-10.11.4').patch, 4);
  assert.equal(parseMysqlVersion('mysql:8.4').minor, 4);
  assert.equal(parseMysqlVersion('latest'), null);
});

test('mysql-lock-wait-timeout: any DDL on an existing table needs lock_wait_timeout first', () => {
  has('ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;', 'mysql-lock-wait-timeout');
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;`, 'mysql-lock-wait-timeout');
  has(`ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;\n${SET}`, 'mysql-lock-wait-timeout');
  lacks('ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT, WAIT 5;', 'mysql-lock-wait-timeout');
  has('RENAME TABLE a TO b;', 'mysql-lock-wait-timeout');
  has('OPTIMIZE TABLE t;', 'mysql-lock-wait-timeout');
  has('CREATE INDEX i ON t (c);', 'mysql-lock-wait-timeout');
  has('DROP INDEX i ON t;', 'mysql-lock-wait-timeout');
  lacks('CREATE TABLE n (id int);', 'mysql-lock-wait-timeout');
  lacks('ALTER TABLE t ADD COLUMN c int NULL;', 'mysql-lock-wait-timeout', { dialect: 'postgres' });
  assert.equal(RULES.find((r) => r.id === 'mysql-lock-wait-timeout').level, 'warning');
});

test('mysql-algorithm-unsupported: INSTANT needs the right server and operation', () => {
  const add = 'ALTER TABLE t ADD COLUMN c int NULL AFTER b, ALGORITHM=INSTANT;';
  has(`${SET}${add}`, 'mysql-algorithm-unsupported', ver('8.0.28'));
  lacks(`${SET}${add}`, 'mysql-algorithm-unsupported', ver('8.0.29'));
  lacks(`${SET}${add}`, 'mysql-algorithm-unsupported');
  has(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', ver('5.7'));
  has(`${SET}ALTER TABLE t DROP COLUMN c, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', ver('8.0.20'));
  lacks(`${SET}ALTER TABLE t DROP COLUMN c, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', ver('8.4'));
  has(`${SET}ALTER TABLE t RENAME COLUMN a TO b, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', ver('8.0.27'));
  has(`${SET}ALTER TABLE t ADD INDEX i (c), ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported');
  has(`${SET}ALTER TABLE t MODIFY COLUMN c bigint, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported');
  has(`${SET}ALTER TABLE t DROP PRIMARY KEY, ALGORITHM=INPLACE;`, 'mysql-algorithm-unsupported');
  lacks(`${SET}ALTER TABLE t DROP PRIMARY KEY, ADD PRIMARY KEY (b), ALGORITHM=INPLACE;`, 'mysql-algorithm-unsupported');
  has(`${SET}ALTER TABLE t ADD FOREIGN KEY (c) REFERENCES p (id), ALGORITHM=INPLACE;`, 'mysql-algorithm-unsupported');
  lacks(`${SET}SET foreign_key_checks = 0;\nALTER TABLE t ADD FOREIGN KEY (c) REFERENCES p (id), ALGORITHM=INPLACE;`, 'mysql-algorithm-unsupported');
  has(`${SET}ALTER TABLE t ADD COLUMN c int, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', ver('mariadb-10.2'));
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL AFTER b, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', ver('mariadb-10.6'));
});

test('mysql-add-foreign-key and mysql-fk-implicit-index', () => {
  const fk = 'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id), ALGORITHM=COPY;';
  has(`${SET}${fk}`, 'mysql-add-foreign-key');
  lacks(`${SET}SET SESSION foreign_key_checks=0;\n${fk}`, 'mysql-add-foreign-key');
  has(`${SET}SET foreign_key_checks=0;\nSET foreign_key_checks=1;\n${fk}`, 'mysql-add-foreign-key');
  has(`${SET}${fk}`, 'mysql-fk-implicit-index');
  lacks(`${SET}ALTER TABLE t ADD INDEX i (user_id), ADD FOREIGN KEY (user_id) REFERENCES users (id), ALGORITHM=COPY;`, 'mysql-fk-implicit-index');
  lacks(`${SET}CREATE INDEX i ON t (user_id);\n${fk}`, 'mysql-fk-implicit-index');
  const shared = { enums: new Map(), indexed: new Map(), instantVersions: new Map() };
  my('CREATE TABLE t (id int, user_id int, KEY k (user_id));', shared);
  lacks(`${SET}${fk}`, 'mysql-fk-implicit-index', shared);
  has(`${SET}${fk}`, 'mysql-add-foreign-key', shared);
  lacks(`${SET}${fk}`, 'mysql-add-foreign-key', { dialect: 'postgres' });
});

test('index and key rules: FULLTEXT, SPATIAL, primary keys', () => {
  has(`${SET}ALTER TABLE t ADD FULLTEXT INDEX f (body), ALGORITHM=INPLACE, LOCK=SHARED;`, 'mysql-fulltext-spatial-index');
  has(`${SET}ALTER TABLE t ADD SPATIAL INDEX s (geo), ALGORITHM=INPLACE, LOCK=SHARED;`, 'mysql-fulltext-spatial-index');
  has(`${SET}CREATE FULLTEXT INDEX f ON t (body);`, 'mysql-fulltext-spatial-index');
  lacks('CREATE TABLE t (id int, body text, FULLTEXT KEY f (body));', 'mysql-fulltext-spatial-index');
  lacks(`${SET}ALTER TABLE t ADD INDEX i (c), ALGORITHM=INPLACE, LOCK=NONE;`, 'mysql-fulltext-spatial-index');
  has(`${SET}ALTER TABLE t DROP PRIMARY KEY, ALGORITHM=COPY;`, 'mysql-drop-primary-key');
  lacks(`${SET}ALTER TABLE t DROP PRIMARY KEY, ADD PRIMARY KEY (b), ALGORITHM=INPLACE;`, 'mysql-drop-primary-key');
  has(`${SET}ALTER TABLE t ADD PRIMARY KEY (b), ALGORITHM=INPLACE, LOCK=NONE;`, 'mysql-add-primary-key');
  has(`${SET}ALTER TABLE t DROP PRIMARY KEY, ADD PRIMARY KEY (b), ALGORITHM=INPLACE;`, 'mysql-add-primary-key');
});

test('mysql-charset-conversion: CONVERT TO and column charset or collation changes', () => {
  has(`${SET}ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci, ALGORITHM=COPY;`, 'mysql-charset-conversion');
  has(`${SET}ALTER TABLE t CONVERT TO CHARSET utf8mb4, ALGORITHM=COPY;`, 'mysql-charset-conversion');
  has(`${SET}ALTER TABLE t MODIFY name varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, ALGORITHM=COPY;`, 'mysql-charset-conversion');
  lacks(`${SET}ALTER TABLE t MODIFY name varchar(50) DEFAULT 'collate x', ALGORITHM=COPY;`, 'mysql-charset-conversion');
  lacks(`${SET}ALTER TABLE t ADD COLUMN name varchar(50) CHARACTER SET utf8mb4 NULL, ALGORITHM=INSTANT;`, 'mysql-charset-conversion');
});

test('mysql-enum-change: append is fine, reorder and storage growth are not, unknown is a warning', () => {
  // the definition comes from an earlier migration (the table is not new in the file that changes it)
  const earlier = (create) => { const shared = { enums: new Map(), indexed: new Map(), instantVersions: new Map() }; my(create, shared); return shared; };
  const create = "CREATE TABLE t (id int, status ENUM('a','b','c'), tags SET('x','y'));";
  const alter = (def) => `${SET}ALTER TABLE t MODIFY COLUMN ${def}, ALGORITHM=INSTANT;`;
  const after = () => earlier(create);
  lacks(alter("status ENUM('a','b','c','d')"), 'mysql-enum-change', after());
  lacks(alter("status ENUM('a','b','c','d')"), 'change-column-type', after());
  has(alter("status ENUM('b','a','c')"), 'mysql-enum-change', after());
  has(alter("status ENUM('a','c')"), 'mysql-enum-change', after());
  has(alter("status ENUM('a','x','b','c')"), 'mysql-enum-change', after());
  lacks(alter("tags SET('x','y','z')"), 'mysql-enum-change', after());
  const nine = Array.from({ length: 9 }, (_, i) => `'m${i}'`).join(',');
  const eight = Array.from({ length: 8 }, (_, i) => `'m${i}'`).join(',');
  has(`${SET}ALTER TABLE t MODIFY COLUMN s SET(${nine}), ALGORITHM=COPY;`, 'mysql-enum-change', earlier(`CREATE TABLE t (id int, s SET(${eight}));`));
  const unknown = findings(alter("status ENUM('a','b')"), { dialect: 'mysql' }).find((f) => f.rule === 'mysql-enum-change');
  assert.equal(unknown.level, 'warning');
  assert.equal(findings(alter("status ENUM('b','a','c')"), { dialect: 'mysql', ...after() }).find((f) => f.rule === 'mysql-enum-change').level, 'error');
  // an ALTER that adds the column teaches the next one its members
  lacks(`${SET}ALTER TABLE t ADD COLUMN k ENUM('a','b'), ALGORITHM=INSTANT;\nALTER TABLE t MODIFY COLUMN k ENUM('a','b','c'), ALGORITHM=INSTANT;`, 'mysql-enum-change');
  has(`${SET}ALTER TABLE t CHANGE COLUMN k kind ENUM('a','b'), ALGORITHM=COPY;`, 'mysql-enum-change');
});

test('mysql-table-rebuild: OPTIMIZE, FORCE, ENGINE=InnoDB, ROW_FORMAT', () => {
  has(`${SET}OPTIMIZE TABLE t;`, 'mysql-table-rebuild');
  has(`${SET}OPTIMIZE NO_WRITE_TO_BINLOG TABLE t, u;`, 'mysql-table-rebuild');
  has(`${SET}ALTER TABLE t FORCE, ALGORITHM=INPLACE, LOCK=NONE;`, 'mysql-table-rebuild');
  has(`${SET}ALTER TABLE t ENGINE=InnoDB, ALGORITHM=INPLACE, LOCK=NONE;`, 'mysql-table-rebuild');
  has(`${SET}ALTER TABLE t ROW_FORMAT=DYNAMIC, ALGORITHM=INPLACE, LOCK=NONE;`, 'mysql-table-rebuild');
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;`, 'mysql-table-rebuild');
  lacks('CREATE TABLE fresh (id int);\nOPTIMIZE TABLE fresh;', 'mysql-table-rebuild');
});

test('mysql-column-position: reorders rebuild; positioned ADD is instant only from 8.0.29', () => {
  const add = `${SET}ALTER TABLE t ADD COLUMN c int NULL AFTER b, ALGORITHM=INPLACE;`;
  has(add, 'mysql-column-position', ver('8.0.28'));
  has(add, 'mysql-column-position', ver('8.0.12'));
  lacks(add, 'mysql-column-position', ver('8.0.29'));
  lacks(add, 'mysql-column-position');
  lacks(add, 'mysql-column-position', ver('mariadb-10.6'));
  has(`${SET}ALTER TABLE t MODIFY COLUMN c int NULL FIRST, ALGORITHM=INPLACE;`, 'mysql-column-position');
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;`, 'mysql-column-position', ver('8.0.28'));
});

test('mysql-change-column-rename: CHANGE restates the definition, RENAME COLUMN does not', () => {
  has(`${SET}ALTER TABLE t CHANGE COLUMN a b int, ALGORITHM=INPLACE;`, 'mysql-change-column-rename');
  lacks(`${SET}ALTER TABLE t CHANGE COLUMN a a bigint, ALGORITHM=COPY;`, 'mysql-change-column-rename');
  lacks(`${SET}ALTER TABLE t CHANGE COLUMN a b int, ALGORITHM=INPLACE;`, 'mysql-change-column-rename', ver('5.7'));
  lacks(`${SET}ALTER TABLE t RENAME COLUMN a TO b, ALGORITHM=INSTANT;`, 'mysql-change-column-rename');
});

test('mysql-instant-row-versions: counts instant add/drop per table across files, a rebuild resets it', () => {
  const add = (n) => `ALTER TABLE t ADD COLUMN c${n} int NULL, ALGORITHM=INSTANT;`;
  const many = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => add(from + i)).join('\n');
  const hit = (sql, ctx) => findings(`${SET}${sql}`, { dialect: 'mysql', ...ctx }).filter((f) => f.rule === 'mysql-instant-row-versions');
  assert.equal(hit(many(1, 55)).length, 0);
  assert.equal(hit(many(1, 60)).length, 5);
  assert.match(hit(many(1, 56))[0].message, /56th instant/);
  assert.equal(hit(`${many(1, 55)}\nALTER TABLE t FORCE, ALGORITHM=INPLACE;\n${many(56, 80)}`).length, 0);
  assert.equal(hit(`${many(1, 55)}\nOPTIMIZE TABLE t;\n${many(56, 80)}`).length, 0);
  assert.equal(hit(many(1, 60), ver('mariadb-10.6')).length, 0);
  // default behaviour is instant on 8.0.12+, but not on 5.7
  assert.equal(hit(many(1, 60).replaceAll(', ALGORITHM=INSTANT', ''), {}).length, 5);
  assert.equal(hit(many(1, 60).replaceAll(', ALGORITHM=INSTANT', ''), ver('5.7')).length, 0);
  // state kept between files of one run
  const shared = { instantVersions: new Map() };
  assert.equal(hit(many(1, 40), shared).length, 0);
  assert.equal(hit(many(41, 60), shared).length, 5);
});

test('rules of other dialects are not applied to PostgreSQL', () => {
  const sql = 'ALTER TABLE t DROP PRIMARY KEY;\nOPTIMIZE TABLE t;\nALTER TABLE t CONVERT TO CHARACTER SET utf8mb4;';
  assert.ok(!ids(sql, { dialect: 'postgres' }).some((r) => r.startsWith('mysql-')));
});

test('--mysql-version changes the findings and the note names the version and where it came from', (t) => {
  const dir = scratch(t);
  put(dir, 'migrations/0001_add.sql', `-- migration-lint: irreversible -- test\n${SET}ALTER TABLE \`t\` ADD COLUMN \`c\` int NULL AFTER \`b\`, ALGORITHM=INSTANT;\n`);
  const run = (...extra) => lintCli([join(dir, 'migrations'), '--format', 'json', ...extra]);
  const rules = (r) => JSON.parse(r.out).findings.map((f) => f.rule);
  assert.deepEqual(rules(run()), []);
  assert.deepEqual(rules(run('--mysql-version', '8.0.28')).sort(), ['mysql-algorithm-unsupported', 'mysql-column-position']);
  assert.deepEqual(rules(run('--mysql-version', 'mariadb-10.6')), []);
  assert.match(JSON.parse(run('--mysql-version', '8.0.28').out).notes[0], /MySQL 8\.0\.28 \(--mysql-version\)/);
  assert.match(JSON.parse(run().out).notes[0], /MySQL 8\.0 \(default/);
  const bad = run('--mysql-version', 'banana');
  assert.equal(bad.code, 2);
  assert.match(bad.out + bad.err, /unknown MySQL version/);
});

test('the server version is read from a compose file or workflow next to the migrations', (t) => {
  const dir = scratch(t);
  put(dir, '.git/HEAD', '');
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: mysql:8.0.28\n');
  put(dir, 'db/migrations/0001_add.sql', '-- migration-lint: irreversible -- test\nSET SESSION lock_wait_timeout = 5;\nALTER TABLE `t` ADD COLUMN `c` int NULL AFTER `b`, ALGORITHM=INSTANT;\n');
  const found = projectMysqlVersion(join(dir, 'db/migrations'));
  assert.equal(found.version.label, 'MySQL 8.0.28');
  const r = lintCli([join(dir, 'db/migrations'), '--format', 'json']);
  assert.deepEqual(JSON.parse(r.out).findings.map((f) => f.rule).sort(), ['mysql-algorithm-unsupported', 'mysql-column-position']);
  assert.match(JSON.parse(r.out).notes[0], /docker-compose\.yml/);
  // an explicit flag wins
  const flag = lintCli([join(dir, 'db/migrations'), '--format', 'json', '--mysql-version', '8.4']);
  assert.deepEqual(JSON.parse(flag.out).findings, []);
  // two different declarations are ambiguous, so the default applies
  put(dir, '.github/workflows/ci.yml', 'jobs:\n  t:\n    services:\n      db:\n        image: mariadb:10.6\n');
  assert.equal(projectMysqlVersion(join(dir, 'db/migrations')), null);
  put(dir, '.github/workflows/ci.yml', 'jobs:\n  t:\n    services:\n      db:\n        image: mysql:8.0.28\n');
  assert.equal(projectMysqlVersion(join(dir, 'db/migrations')).version.label, 'MySQL 8.0.28');
});

test('good MySQL fixtures are clean under --strict on every supported version of the series they target', () => {
  const dir = join(import.meta.dirname, '..', 'skills', 'migrations-safe', 'fixtures', 'good', 'mysql');
  for (const v of ['8.0', '8.0.29', '8.4']) {
    const r = lintCli([dir, '--strict', '--mysql-version', v, '--format', 'json']);
    assert.deepEqual(JSON.parse(r.out).findings, [], v);
    assert.equal(r.code, 0);
  }
});
