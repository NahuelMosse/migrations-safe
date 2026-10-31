import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseMysqlVersion } from '../skills/migrations-safe/scripts/lib/mysql.mjs';
import { projectServerVersion } from '../skills/migrations-safe/scripts/lib/server-version.mjs';
const projectMysqlVersion = (p) => projectServerVersion(p, 'mysql');
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
  lacks('ALTER TABLE t WAIT 5 ADD COLUMN c int NULL, ALGORITHM=INSTANT;', 'mysql-lock-wait-timeout');
  lacks('ALTER TABLE t NOWAIT ADD COLUMN c int NULL, ALGORITHM=INSTANT;', 'mysql-lock-wait-timeout');
  lacks('SET @@lock_wait_timeout = 5;\nALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;', 'mysql-lock-wait-timeout');
  lacks('SET LOCAL lock_wait_timeout = 5;\nALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;', 'mysql-lock-wait-timeout');
  has('SET GLOBAL lock_wait_timeout = 5;\nALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;', 'mysql-lock-wait-timeout');
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
  // declarations that disagree: the oldest of the flavor is used and the run says so
  put(dir, '.github/workflows/ci.yml', 'jobs:\n  t:\n    services:\n      db:\n        image: mysql:8.0.20\n');
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: mysql:5.7\n');
  const conflict = projectMysqlVersion(join(dir, 'db/migrations'));
  assert.equal(conflict.version.label, 'MySQL 5.7');
  assert.deepEqual(conflict.conflict.sort(), ['MySQL 5.7', 'MySQL 8.0.20']);
  const noted = JSON.parse(lintCli([join(dir, 'db/migrations'), '--format', 'json']).out).notes.join('\n');
  assert.match(noted, /disagree \(MySQL 5\.7, MySQL 8\.0\.20\): using the oldest, MySQL 5\.7/);
  put(dir, '.github/workflows/ci.yml', 'jobs:\n  t:\n    services:\n      db:\n        image: mysql:8.0.28\n');
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: mysql:8.0.28\n');
  assert.equal(projectMysqlVersion(join(dir, 'db/migrations')).conflict, null);
  // a tag without minor ("mysql:8", "mariadb:11") is read as the newest of that major
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: mysql:8\n');
  put(dir, '.github/workflows/ci.yml', 'name: ci\n');
  assert.equal(projectMysqlVersion(join(dir, 'db/migrations')).version.major, 8);
  assert.match(projectMysqlVersion(join(dir, 'db/migrations')).version.label, /MySQL 8 \(newest minor\)/);
});

// What earlier migrations taught: shared maps filled by linting the CREATE TABLE first.
const afterCreate = (create, version) => {
  const shared = { enums: new Map(), indexed: new Map(), defs: new Map(), instantVersions: new Map(), ...(version ? ver(version) : {}) };
  my(create, shared);
  return shared;
};
const level = (sql, rule, ctx) => findings(sql, { dialect: 'mysql', ...ctx }).find((f) => f.rule === rule)?.level;

test('S4: error-level algorithm findings are limited to what the server really rejects', () => {
  const t = afterCreate('CREATE TABLE t (id int, a int NULL, name varchar(50) NOT NULL, note text);');
  // a default-only MODIFY runs INSTANT on MySQL 8.0.29+
  lacks(`${SET}ALTER TABLE t MODIFY a int NULL DEFAULT 5, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', t);
  // a type or nullability change does not, and the earlier definition makes it certain
  assert.equal(level(`${SET}ALTER TABLE t MODIFY a bigint NULL, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', afterCreate('CREATE TABLE t (id int, a int NULL);')), 'error');
  assert.equal(level(`${SET}ALTER TABLE t MODIFY name varchar(50) NULL, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', afterCreate('CREATE TABLE t (id int, name varchar(50) NOT NULL);')), 'error');
  // without the earlier definition it is only a warning
  assert.equal(level(`${SET}ALTER TABLE t MODIFY a int NULL DEFAULT 5, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported'), 'warning');
  // CONVERT with INPLACE can run (unindexed utf8mb3 to utf8mb4): a warning, not an error
  assert.equal(level(`${SET}ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4, ALGORITHM=INPLACE, LOCK=NONE;`, 'mysql-algorithm-unsupported'), 'warning');
  assert.equal(level(`${SET}ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported'), 'error');
  // MariaDB 10.4+ runs charset changes, repositioning and CONVERT with INSTANT
  const maria = ver('mariadb-11.8');
  const m = afterCreate('CREATE TABLE t (id int, name varchar(50) NOT NULL);', 'mariadb-11.8');
  lacks(`${SET}ALTER TABLE t MODIFY name varchar(50) NOT NULL COLLATE utf8mb4_bin, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', m);
  lacks(`${SET}ALTER TABLE t MODIFY name varchar(50) NOT NULL FIRST, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', m);
  lacks(`${SET}ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', maria);
  lacks(`${SET}ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4, ALGORITHM=INPLACE;`, 'mysql-algorithm-unsupported', maria);
  // MariaDB 11.2+ copies online: the text must not say writes are blocked
  const copy = findings(`${SET}ALTER TABLE t DROP PRIMARY KEY, ALGORITHM=COPY;`, { dialect: 'mysql', ...maria }).find((f) => f.rule === 'mysql-drop-primary-key');
  assert.match(copy.message, /online on MariaDB 11\.2\+/);
  assert.ok(!/writes are blocked/.test(copy.message));
  const old = findings(`${SET}ALTER TABLE t DROP PRIMARY KEY, ALGORITHM=COPY;`, { dialect: 'mysql', ...ver('mariadb-10.6') }).find((f) => f.rule === 'mysql-drop-primary-key');
  assert.match(old.message, /writes are blocked/);
  // CHANGE with a type change and INSTANT is flagged
  has(`${SET}ALTER TABLE t CHANGE COLUMN a a bigint NULL, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', afterCreate('CREATE TABLE t (id int, a int NULL);'));
});

test('S5: INSTANT cannot be combined with a LOCK clause (ERROR 1221), and the no-algorithm advice says so', () => {
  has(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT, LOCK=NONE;`, 'mysql-algorithm-unsupported');
  has(`${SET}ALTER TABLE t ADD COLUMN c int NULL, LOCK=SHARED, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported');
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported');
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT, LOCK=DEFAULT;`, 'mysql-algorithm-unsupported');
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INPLACE, LOCK=NONE;`, 'mysql-algorithm-unsupported');
  const msg = findings('ALTER TABLE t ADD COLUMN c int NULL;', { dialect: 'mysql' }).find((f) => f.rule === 'mysql-no-algorithm').message;
  assert.ok(!/INSTANT\|INPLACE, LOCK=NONE/.test(msg));
  assert.match(msg, /ALGORITHM=INSTANT \(alone/);
  assert.match(findings(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT, LOCK=NONE;`, { dialect: 'mysql' }).find((f) => f.rule === 'mysql-algorithm-unsupported').message, /ERROR 1221/);
});

test('error codes in messages: 1800 where INSTANT does not exist, 1845 or 1846 otherwise', () => {
  const old = findings(`${SET}ALTER TABLE t ADD COLUMN c int NULL, ALGORITHM=INSTANT;`, { dialect: 'mysql', ...ver('5.7') }).find((f) => f.rule === 'mysql-algorithm-unsupported');
  assert.match(old.message, /ERROR 1800/);
  const fk = findings(`${SET}ALTER TABLE t ADD INDEX i (c), ALGORITHM=INSTANT;`, { dialect: 'mysql' }).find((f) => f.rule === 'mysql-algorithm-unsupported');
  assert.match(fk.message, /ERROR 1845 or 1846/);
  assert.ok(!/with ERROR 1845 instead/.test(fk.message));
});

test('S6: MariaDB WAIT n / NOWAIT before the actions neither fire the timeout rule nor hide the action rules', () => {
  const drop = ids(`ALTER TABLE c NOWAIT DROP COLUMN note;`, { dialect: 'mysql' });
  assert.ok(drop.includes('drop-column'), drop);
  assert.ok(!drop.includes('mysql-lock-wait-timeout'));
  has('ALTER TABLE c WAIT 5 ADD COLUMN v INT NOT NULL, ALGORITHM=INPLACE;', 'not-null-without-default');
  has('ALTER ONLINE TABLE c ADD COLUMN v INT NOT NULL;', 'not-null-without-default');
  assert.ok(ids('ALTER TABLE c WAIT 5 DROP COLUMN note;', { dialect: 'postgres' }).includes('drop-column'));
});

test('S8: ENUM members and indexes come from earlier files of the folder and from --schema', (t) => {
  const dir = scratch(t);
  put(dir, 'm/0001_create.sql', "-- migration-lint: irreversible -- test\nCREATE TABLE `tickets` (`id` bigint NOT NULL, `user_id` bigint NOT NULL, `status` ENUM('a','b') NOT NULL, KEY `k_user` (`user_id`)) ENGINE=InnoDB;\n");
  const second = put(dir, 'm/0002_alter.sql', `-- migration-lint: irreversible -- test\n${SET}ALTER TABLE \`tickets\` MODIFY COLUMN \`status\` ENUM('a','b','c') NOT NULL, ALGORITHM=INSTANT;\nSET SESSION foreign_key_checks = 0;\nALTER TABLE \`tickets\` ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id), ALGORITHM=INPLACE;\n`);
  const rules = (args) => JSON.parse(lintCli([...args, '--format', 'json']).out).findings.map((f) => f.rule);
  // only the second file is linted: the first is replayed
  assert.deepEqual(rules([second]), []);
  // a file elsewhere with --schema
  const elsewhere = put(dir, 'other/0001_alter.sql', second ? `-- migration-lint: irreversible -- test\n-- migration-lint: dialect mysql\n${SET}ALTER TABLE \`tickets\` MODIFY COLUMN \`status\` ENUM('a','b','c') NOT NULL, ALGORITHM=INSTANT;\nSET SESSION foreign_key_checks = 0;\nALTER TABLE \`tickets\` ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id), ALGORITHM=INPLACE;\n` : '');
  assert.deepEqual(rules([elsewhere]).sort(), ['mysql-enum-change', 'mysql-fk-implicit-index']);
  assert.deepEqual(rules([elsewhere, '--schema', join(dir, 'm/0001_create.sql')]), []);
});

test('instant row versions: only from 8.0.29, and a statement with an index is not instant', () => {
  const add = (n) => `ALTER TABLE t ADD COLUMN c${n} int NULL, ALGORITHM=INSTANT;`;
  const many = (to) => Array.from({ length: to }, (_, i) => add(i + 1)).join('\n');
  const hits = (sql, ctx) => findings(`${SET}${sql}`, { dialect: 'mysql', ...ctx }).filter((f) => f.rule === 'mysql-instant-row-versions').length;
  assert.equal(hits(many(60), ver('8.0.28')), 0);
  assert.equal(hits(many(60), ver('8.0.29')), 5);
  const withIndex = Array.from({ length: 60 }, (_, i) => `ALTER TABLE t ADD COLUMN c${i} int NULL, ADD INDEX i${i} (c${i}), ALGORITHM=INPLACE;`).join('\n');
  assert.equal(hits(withIndex), 0);
  const noAlgo = Array.from({ length: 60 }, (_, i) => `ALTER TABLE t ADD COLUMN c${i} int NULL, ADD INDEX i${i} (c${i});`).join('\n');
  assert.equal(hits(noAlgo), 0);
});

test('instant row versions of earlier files count in a --history style run (only the last file is linted)', (t) => {
  const dir = scratch(t);
  const body = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `ALTER TABLE \`t\` ADD COLUMN \`c${from + i}\` int NULL, ALGORITHM=INSTANT;`).join('\n');
  put(dir, 'm/0001_create.sql', '-- migration-lint: irreversible -- test\nCREATE TABLE `t` (`id` int) ENGINE=InnoDB;\n');
  put(dir, 'm/0002_many.sql', `-- migration-lint: irreversible -- test\n${SET}${body(1, 55)}\n`);
  const last = put(dir, 'm/0003_more.sql', `-- migration-lint: irreversible -- test\n${SET}${body(56, 58)}\n`);
  const found = JSON.parse(lintCli([last, '--format', 'json']).out).findings.filter((f) => f.rule === 'mysql-instant-row-versions');
  assert.equal(found.length, 3);
  assert.match(found[0].message, /56th instant/);
});

test('ENUM append that also changes nullability is not INSTANT; MariaDB 10.3 ADD AFTER is flagged without ALGORITHM', () => {
  const t = afterCreate("CREATE TABLE t (id int, status ENUM('a','b') NOT NULL);");
  has(`${SET}ALTER TABLE t MODIFY COLUMN status ENUM('a','b','c') NULL, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', t);
  lacks(`${SET}ALTER TABLE t MODIFY COLUMN status ENUM('a','b','c') NOT NULL, ALGORITHM=INSTANT;`, 'mysql-algorithm-unsupported', afterCreate("CREATE TABLE t (id int, status ENUM('a','b') NOT NULL);"));
  has(`${SET}ALTER TABLE t ADD COLUMN c int NULL AFTER id;`, 'mysql-column-position', ver('mariadb-10.3'));
  lacks(`${SET}ALTER TABLE t ADD COLUMN c int NULL AFTER id;`, 'mysql-column-position', ver('mariadb-10.4'));
});

test('good MySQL fixtures are clean under --strict on every supported version of the series they target', () => {
  const dir = join(import.meta.dirname, '..', 'skills', 'migrations-safe', 'fixtures', 'good', 'mysql');
  for (const v of ['8.0', '8.0.29', '8.4']) {
    const r = lintCli([dir, '--strict', '--mysql-version', v, '--format', 'json']);
    assert.deepEqual(JSON.parse(r.out).findings, [], v);
    assert.equal(r.code, 0);
  }
});
