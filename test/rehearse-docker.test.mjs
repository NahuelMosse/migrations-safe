import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { SIGNAL_EXIT, locksIn, makeEngine, mysqlInput, parseDuration, parseEngine, seedBytes } from '../skills/migrations-safe/scripts/lib/rehearse-docker.mjs';
import { FIXTURES, REHEARSE_ANY, put, scratch } from './helpers.mjs';

// ── unit tests: no docker needed ─────────────────────────────────────────────────────────────────

const cli = (args, { env, cwd } = {}) => {
  const r = spawnSync(process.execPath, [REHEARSE_ANY, ...args], { encoding: 'utf8', env: env ?? process.env, cwd, windowsHide: true, timeout: 1500000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// An environment whose PATH holds only `dir` (and nothing else): `docker` resolves to what the test puts there.
const onlyPath = (dir) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)));
  return { ...env, PATH: dir };
};

// A `docker` command that answers like the script says: `body` is JavaScript with `args` in scope.
const fakeDocker = (t, body) => {
  const dir = scratch(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'docker-fake.mjs'), `const args = process.argv.slice(2);\n${body}\n`);
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'docker-fake.mjs')}" "$@"\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  return dir;
};

const PG_SEED = join(FIXTURES, 'seed-postgres.sql');
const MY_SEED = join(FIXTURES, 'seed-mysql.sql');

test('--engine and --lock-budget values are parsed and validated', () => {
  assert.deepEqual(parseEngine('postgres:16'), { kind: 'postgres', tag: '16', image: 'postgres:16' });
  assert.equal(parseEngine('mariadb:11.4').image, 'mariadb:11.4');
  assert.equal(parseEngine('mysql:8.4').kind, 'mysql');
  for (const bad of ['postgres', 'nosuch:1', 'mysql:', '']) assert.throws(() => parseEngine(bad), /--engine takes/);
  assert.equal(parseDuration('2'), 2000);
  assert.equal(parseDuration('2s'), 2000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('0.5'), 500);
  assert.throws(() => parseDuration('soon'), /--lock-budget takes a duration/);
});

test('rehearse --help documents the engines, --dump, --keep and --lock-budget', () => {
  const r = cli(['--help']);
  assert.equal(r.code, 0);
  for (const word of ['--engine', 'postgres:<tag>', '--dump', '--keep', '--lock-budget', 'msafe-rehearse-']) assert.ok(r.out.includes(word), word);
});

test('server-engine arguments are validated before docker is touched: exit 2', (t) => {
  const dir = scratch(t);
  const up = put(dir, '0001.sql', 'SELECT 1;\n');
  const noDocker = { env: onlyPath(scratch(t)) };
  assert.equal(cli(['--engine', 'nosuch:1', PG_SEED, up], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, join(dir, 'missing.sql')], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, up, '--lock-budget', 'soon'], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, up, '--foreign-keys', 'on'], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, up, '--runner', 'nope'], noDocker).code, 2);
  for (const flag of [['--keep'], ['--dump', PG_SEED], ['--lock-budget', '1s'], ['--disk']]) {
    const r = cli([...flag, '--engine', 'sqlite', ...(flag[0] === '--dump' ? [] : [join(FIXTURES, 'seed-sqlite.sql')]), up]);
    assert.equal(r.code, 2, flag[0]);
    assert.match(r.err, /needs a server engine/);
  }
});

test('docker missing from PATH is exit 2 with a clear message, never a pass', (t) => {
  const dir = scratch(t);
  const up = put(dir, '0001.sql', 'SELECT 1;\n');
  for (const engine of ['postgres:16', 'mysql:8.4', 'mariadb:11']) {
    const r = cli(['--engine', engine, PG_SEED, up], { env: onlyPath(scratch(t)) });
    assert.equal(r.code, 2, engine);
    assert.match(r.err, /could not run: docker is not available: the `docker` command was not found/);
    assert.equal(r.out, '');
  }
});

test('--dump after the migrations is an error, not a silently dropped migration', (t) => {
  const dir = scratch(t);
  const a = put(dir, '002_drop_note.sql', 'ALTER TABLE orders DROP COLUMN note;\n');
  const b = put(dir, '003_add.sql', 'ALTER TABLE orders ADD COLUMN c int;\n');
  const r = cli(['--engine', 'postgres:16', a, b, '--dump', PG_SEED], { env: onlyPath(scratch(t)) });
  assert.equal(r.code, 2);
  assert.match(r.err, /--dump .* would replace the seed or migration already given/);
  assert.equal(cli(['--engine', 'postgres:16', '--dump', PG_SEED, '--dump', PG_SEED, a], { env: onlyPath(scratch(t)) }).code, 2);
});

test('a migration with no SQL statements is exit 2, not "ran"', (t) => {
  const dir = scratch(t);
  const empty = put(dir, '0001_empty.sql', '-- nothing here\n');
  const r = cli(['--engine', 'postgres:16', PG_SEED, empty], { env: onlyPath(scratch(t)) });
  assert.equal(r.code, 2);
  assert.match(r.err, /0001_empty\.sql has no SQL statements/);
  const noDown = put(dir, '0002.sql', '-- migrate:up\nSELECT 1;\n-- migrate:down\n-- empty\n');
  assert.match(cli(['--engine', 'postgres:16', PG_SEED, noDown, '--down'], { env: onlyPath(scratch(t)) }).err, /the down of .* has no SQL statements/);
});

test('the size of a .gz seed is its unpacked size, so the memory-backed data directory is not chosen for a big one', (t) => {
  const dir = scratch(t);
  const gz = join(dir, 'big.sql.gz');
  const plain = 'INSERT INTO t VALUES (1);\n'.repeat(200000);
  writeFileSync(gz, gzipSync(plain));
  assert.equal(seedBytes(gz), plain.length);
  assert.ok(readFileSync(gz).length < plain.length / 10);
  const small = put(dir, 'small.sql', 'SELECT 1;\n');
  assert.equal(seedBytes(small), 10);
});

test('locks of one table are merged across modes, and only tables that existed are reported', () => {
  const sample = (t, ...rows) => ({ t, rows });
  const samples = [
    sample(100, ['AccessExclusiveLock', 'public.orders'], ['ShareLock', 'public.orders'], ['AccessExclusiveLock', 'public.fresh']),
    sample(150, ['AccessExclusiveLock', 'public.orders'], ['ShareLock', 'public.orders']),
    sample(200, ['ShareLock', 'public.orders']),
    sample(250),
  ];
  const held = locksIn(samples, 90, 260, new Set(['orders']), (t) => t.replace(/^public\./, ''));
  assert.equal(held.length, 1);
  assert.equal(held[0].table, 'orders');
  assert.deepEqual(held[0].modes, ['AccessExclusiveLock', 'ShareLock']);
  assert.equal(held[0].polls, 3);
  assert.equal(held[0].ms, 100 + 50);
});

test('signal exit codes follow the shell convention', () => {
  assert.deepEqual(SIGNAL_EXIT, { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
});

test('MySQL statements are sent with a statement delimiter that keeps compound statements whole', () => {
  const proc = '-- +goose Up\n-- +goose StatementBegin\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END\n-- +goose StatementEnd\nALTER TABLE t ADD COLUMN c int;\n';
  const { input, marked } = mysqlInput(proc, { wrap: true, marks: true });
  assert.ok(marked);
  assert.match(input, /^START TRANSACTION;\nDELIMITER ;;\nSELECT CONCAT\('@@T0 '/);
  assert.ok(input.includes('CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;;'), input);
  assert.ok(input.includes('ALTER TABLE t ADD COLUMN c int;;'));
  assert.match(input, /DELIMITER ;\nCOMMIT;\n$/);
  // a file that manages its own DELIMITER is sent untouched
  const own = 'DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\n';
  assert.equal(mysqlInput(own, { wrap: false, marks: true }).input, own);
  assert.equal(mysqlInput(own, { wrap: false, marks: true }).marked, false);
});

test('error descriptions carry a position or code, never the text of the error', () => {
  const pg = makeEngine({ kind: 'postgres', image: 'postgres:16' });
  const my = makeEngine({ kind: 'mysql', image: 'mysql:8.4' });
  assert.equal(pg.describeError('psql:<stdin>:12: ERROR:  duplicate key value violates unique constraint "u" DETAIL: Key (email)=(a@b.c)'), 'at line 12');
  assert.equal(my.describeError("ERROR 1062 (23000) at line 7: Duplicate entry 'a@b.c' for key 'u'"), 'ERROR 1062 (23000) at line 7');
});

test('SQL Server: --edition picks MSSQL_PID, Express stops at 10 GB, errors are described by number and line', () => {
  const run = (tag, edition) => makeEngine({ kind: 'mssql', tag, image: `mcr.microsoft.com/mssql/server:${tag}` }, { edition }).runArgs({});
  assert.ok(run('2022-latest', 'standard').includes('MSSQL_PID=Express'));
  assert.ok(run('2019-latest', undefined).includes('MSSQL_PID=Express'));
  assert.ok(run('2025-latest', 'standard').includes('MSSQL_PID=StandardDeveloper'));
  assert.ok(run('2022-latest', 'enterprise').includes('MSSQL_PID=Developer'));
  assert.ok(!run('2022-latest', 'standard').join(' ').includes('--tmpfs'), 'SQL Server needs O_DIRECT: no tmpfs');
  const big = 11 * 1024 ** 3;
  assert.throws(() => makeEngine({ kind: 'mssql', tag: '2022-latest', image: 'x' }, { edition: 'standard' }).checkSeed(big), /stops at 10 GB per database/);
  makeEngine({ kind: 'mssql', tag: '2022-latest', image: 'x' }, { edition: 'enterprise' }).checkSeed(big);
  makeEngine({ kind: 'mssql', tag: '2025-latest', image: 'x' }, { edition: 'standard' }).checkSeed(big);
  const ms = makeEngine({ kind: 'mssql', tag: '2022-latest', image: 'x' });
  assert.equal(ms.describeError("Msg 2714, Level 16, State 6, Server 5fe6, Line 3\nThere is already an object named 'x'"), 'Msg 2714 at line 3');
  assert.deepEqual(ms.errorLines('Msg 4902, Level 16, State 1, Server s, Line 1\nCannot find the object "t" containing 5 rows'), ['Msg 4902, Level 16, State 1, Server s, Line 1']);
  assert.match(ms.pollInput(), /dm_tran_locks[^]*'Sch-M', 'X', 'SIX', 'S'[^]*@@END/);
  assert.match(ms.probe.hold, /TABLOCKX, HOLDLOCK[^]*WAITFOR DELAY '00:00:03'/);
});

test('Oracle and Db2 scripts are rebuilt from their statements for the client', () => {
  const ora = makeEngine({ kind: 'oracle', tag: '23-slim', image: 'x' }, {});
  const o = ora.scriptInput("SET DEFINE OFF\nALTER TABLE t ADD (c NUMBER);\nBEGIN\n  EXECUTE IMMEDIATE 'ALTER TABLE t ADD (d NUMBER)';\nEND;\n/\n", { wrap: false, marks: true });
  assert.ok(o.marked);
  assert.match(o.input, /SET DEFINE OFF\nALTER TABLE t ADD \(c NUMBER\);\nBEGIN\n  EXECUTE IMMEDIATE 'ALTER TABLE t ADD \(d NUMBER\)';\nEND;\n\/\n/);
  assert.equal((o.input.match(/ALTER TABLE t ADD \(d NUMBER\)/g) ?? []).length, 1, 'the statement inside a block is not sent twice');
  assert.match(ora.pollerArgs('c').join(' '), /SYSTEM\//);
  assert.match(ora.scriptArgs('c', { app: 'msafe-migration', stopOnError: true }).join(' '), /WHENEVER SQLERROR EXIT FAILURE[^]*SET_MODULE\(\S{1,5}msafe-migration/);
  assert.ok(!ora.scriptArgs('c', { app: 'x', stopOnError: false }).join(' ').includes('WHENEVER SQLERROR'));
  assert.match(ora.pollInput(), /v\$lock[^]*dba_ddl_locks[^]*@@END/);
  assert.equal(ora.describeError('ORA-00942: table or view does not exist'), 'ORA-00942');
  assert.match(ora.editionNote, /not emulated/);
  const db2 = makeEngine({ kind: 'db2', tag: '11.5.9.0', image: 'x' }, {});
  const d = db2.scriptInput("--#SET TERMINATOR @\nCREATE TRIGGER x AFTER INSERT ON t FOR EACH ROW BEGIN ATOMIC SELECT 1 FROM sysibm.sysdummy1; END@\nALTER TABLE t ADD COLUMN c INTEGER@\n", { wrap: true, marks: true });
  assert.match(d.input, /^UPDATE COMMAND OPTIONS USING C OFF~\nVALUES CHR\(64\)/);
  assert.match(d.input, /BEGIN ATOMIC SELECT 1 FROM sysibm\.sysdummy1; END\n~\nALTER TABLE t ADD COLUMN c INTEGER\n~\n/);
  assert.match(d.input, /COMMIT~\nVALUES CHR\(64\) \|\| CHR\(64\) \|\| 'T1 '/);
  assert.match(db2.scriptArgs('c', { app: 'a', stopOnError: true }).join(' '), /-td~ -s/);
  assert.match(db2.scriptArgs('c', { app: 'a', stopOnError: false, dump: true }).join(' '), /db2 -x -t -f/);
  assert.match(db2.pollInput(), /MON_GET_LOCKS[^]*CLIENT_APPLNAME = 'msafe-migration'[^]*'Z', 'X', 'S', 'SIX'/);
  assert.match(db2.runArgs({}).join(' '), /--privileged -e LICENSE=accept/);
  assert.match(db2.pendingProbe.sql, /DROP COLUMN c2/);
  assert.equal(db2.describeError('SQL0204N  "DB2INST1.X" is an undefined name.  SQLSTATE=42704'), 'SQL0204N');
});

test('SQL Server scripts are sent with GO batches, marks inside the server and a transaction only when the runner wraps', () => {
  const ms = makeEngine({ kind: 'mssql', tag: '2022-latest', image: 'x' });
  const plain = ms.scriptInput('ALTER TABLE t ADD c int;', { wrap: false, marks: true });
  assert.ok(plain.marked);
  assert.match(plain.input, /^SET NOCOUNT ON;\nSELECT CONCAT\('@@T0 '[^]*ALTER TABLE t ADD c int;\nGO\nSELECT CONCAT\('@@T1 '/);
  assert.ok(!/BEGIN TRANSACTION/.test(plain.input));
  const wrapped = ms.scriptInput('ALTER TABLE t ADD c int;', { wrap: true, marks: true }).input;
  assert.match(wrapped, /SET XACT_ABORT ON;\nBEGIN TRANSACTION;\nGO\n[^]*COMMIT TRANSACTION;\nGO\n$/);
  assert.ok(ms.base('c').includes('127.0.0.1'), 'a container with no network has no ::1');
});

test('--edition is validated per engine before docker is touched: exit 2', (t) => {
  const up = put(scratch(t), '0001.sql', 'SELECT 1;\n');
  const noDocker = { env: onlyPath(scratch(t)) };
  for (const args of [['--engine', 'postgres:16', '--edition', 'standard'], ['--engine', 'mssql:2022-latest', '--edition', 'se2'], ['--engine', 'oracle:23', '--edition', 'standard'], ['--engine', 'sqlite', '--edition', 'standard']]) {
    const r = cli([...args, PG_SEED, up], noDocker);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /--edition/);
  }
  const ok = cli(['--engine', 'mssql:2022-latest', '--edition', 'enterprise', PG_SEED, up], noDocker);
  assert.match(ok.err, /docker is not available/);
});

// A fake docker is an executable script: Node cannot spawn .cmd files on Windows.
const FAKE_SKIP = process.platform === 'win32' ? 'skipped: a fake docker command needs a POSIX shell' : false;

test('a docker daemon that does not answer is exit 2', { skip: FAKE_SKIP }, (t) => {
  const dir = scratch(t);
  const up = put(dir, '0001.sql', 'SELECT 1;\n');
  const bin = fakeDocker(t, "if (args[0] === 'version') { console.error('Cannot connect to the Docker daemon'); process.exit(1); }\nprocess.exit(0);");
  const r = cli(['--engine', 'postgres:16', PG_SEED, up], { env: onlyPath(bin) });
  assert.equal(r.code, 2);
  assert.match(r.err, /docker is not available: the daemon did not answer \(Cannot connect to the Docker daemon\)/);
});

test('an image that cannot be pulled is exit 2 and no container is started', { skip: FAKE_SKIP }, (t) => {
  const dir = scratch(t);
  const up = put(dir, '0001.sql', 'SELECT 1;\n');
  const calls = join(dir, 'calls.txt');
  const bin = fakeDocker(t, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args[0] === 'version') { console.log('27.0.0'); process.exit(0); }
if (args[0] === 'image') process.exit(1);
if (args[0] === 'pull') { console.error('Error response from daemon: manifest for postgres:nope not found'); process.exit(1); }
process.exit(0);`);
  const r = cli(['--engine', 'postgres:nope', PG_SEED, up], { env: onlyPath(bin) });
  assert.equal(r.code, 2);
  assert.match(r.err, /could not run: cannot pull postgres:nope: Error response from daemon: manifest for postgres:nope not found/);
  const seen = spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(calls)}, 'utf8'))`], { encoding: 'utf8' }).stdout;
  assert.ok(!/^run /m.test(seen), seen);
});

// ── docker integration tests ─────────────────────────────────────────────────────────────────────────

const dockerUp = () => {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return r.status === 0;
};
const available = dockerUp();
const disabled = process.env.MSAFE_DOCKER_TESTS === '0';
const required = process.env.MSAFE_REQUIRE_DOCKER === '1';
const skip = disabled ? 'skipped: docker tests disabled (MSAFE_DOCKER_TESTS=0)' : available ? false : 'skipped: docker not available';
const ENGINES = (process.env.MSAFE_DOCKER_ENGINES ?? 'postgres:16,mysql:8.4').split(',').map((s) => s.trim()).filter(Boolean);

test('docker is available when the run requires it', { skip: !required || disabled }, () => {
  assert.ok(available, 'MSAFE_REQUIRE_DOCKER=1 but docker is not available');
});

const containerOf = (out) => out.match(/in container (msafe-rehearse-[\w-]+)/)?.[1];
const exists = (name) => spawnSync('docker', ['inspect', name], { stdio: 'ignore', windowsHide: true }).status === 0;
const remove = (name) => spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', windowsHide: true });


// What each engine family needs: a seed, the statements the shared scenarios run, and what they must print.
const SCENARIOS = {
  postgres: {
    seed: PG_SEED, add: 'ALTER TABLE orders ADD COLUMN due_on date;\n',
    lock: 'BEGIN;\nLOCK TABLE orders IN ACCESS EXCLUSIVE MODE;\nSELECT pg_sleep(1.5);\nCOMMIT;\n', lockRe: /lock: AccessExclusiveLock on orders held ~1\.\d\d s \(\d+ poll\(s\)\), over the 0\.5 s budget/,
    drop: 'ALTER TABLE orders DROP COLUMN note;\n',
    dump: `SET statement_timeout = 0;\nCREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL);\nALTER TABLE users OWNER TO no_such_role;\nCOPY users (id, email) FROM stdin;\n1\ta@example.com\n2\tb@example.com\n\\.\n`,
    dumpError: /at line 3\n/,
    up: '-- +goose Up\nALTER TABLE users ADD COLUMN nickname text;\nUPDATE users SET nickname = split_part(email, \'@\', 1);\n-- +goose Down\nALTER TABLE users DROP COLUMN nickname;\n', runner: /goose|dbmate/,
    bad: 'ALTER TABLE no_such_table ADD COLUMN x int;\n', after: 'ALTER TABLE users ADD COLUMN y int;\n',
  },
  mysql: {
    seed: MY_SEED, add: 'ALTER TABLE orders ADD COLUMN due_on date NULL;\n',
    lock: 'LOCK TABLES orders WRITE;\nSELECT SLEEP(1.5);\nUNLOCK TABLES;\n', lockRe: /lock: SHARED_NO_READ_WRITE on orders held ~1\.\d\d s .*over the 0\.5 s budget/,
    drop: 'ALTER TABLE orders DROP COLUMN note;\n',
    dump: "/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE `users` (`id` int NOT NULL PRIMARY KEY, `email` varchar(100) NOT NULL) ENGINE=InnoDB;\nALTER TABLE `missing_table` ADD COLUMN x int;\nLOCK TABLES `users` WRITE;\nINSERT INTO `users` VALUES (1,'a@example.com'),(2,'b@example.com');\nUNLOCK TABLES;\n",
    dumpError: /ERROR 1146 \(42S02\) at line 3\n/,
    up: "-- migrate:up\nALTER TABLE users ADD COLUMN nickname varchar(50) NULL;\nUPDATE users SET nickname = SUBSTRING_INDEX(email, '@', 1);\n-- migrate:down\nALTER TABLE users DROP COLUMN nickname;\n", runner: /goose|dbmate/,
    extra: [['0002_proc.sql', '-- +goose Up\n-- +goose StatementBegin\nCREATE PROCEDURE msafe_touch() BEGIN SELECT 1; SELECT 2; END\n-- +goose StatementEnd\n-- +goose Down\nDROP PROCEDURE msafe_touch;\n']],
    bad: 'ALTER TABLE no_such_table ADD COLUMN x int;\n', after: 'ALTER TABLE users ADD COLUMN y int;\n',
  },
  oracle: {
    seed: join(FIXTURES, 'seed-oracle.sql'), add: 'ALTER TABLE orders ADD (due_on DATE);\n',
    lock: 'LOCK TABLE orders IN EXCLUSIVE MODE;\nEXEC DBMS_SESSION.SLEEP(1.5);\nCOMMIT;\n', lockRe: /lock: X on orders held ~1\.\d\d s \(\d+ poll\(s\)\), over the 0\.5 s budget/,
    drop: 'ALTER TABLE orders DROP COLUMN note;\n',
    dump: "CREATE TABLE users (id NUMBER PRIMARY KEY, email VARCHAR2(100) NOT NULL);\nALTER TABLE missing_table ADD (x NUMBER);\nINSERT INTO users VALUES (1, 'a@example.com');\nINSERT INTO users VALUES (2, 'b@example.com');\nCOMMIT;\n",
    dumpError: /ORA-00942\n/,
    up: "-- migrate:up\nALTER TABLE users ADD (nickname VARCHAR2(50));\nUPDATE users SET nickname = SUBSTR(email, 1, INSTR(email, '@') - 1);\nCOMMIT;\n-- migrate:down\nALTER TABLE users DROP COLUMN nickname;\n",
    bad: 'ALTER TABLE no_such_table ADD (x NUMBER);\n', badRe: /ORA-00942/, after: 'ALTER TABLE users ADD (y NUMBER);\n',
  },
  db2: {
    seed: join(FIXTURES, 'seed-db2.sql'), add: 'ALTER TABLE orders ADD COLUMN due_on DATE;\n',
    lock: 'UPDATE COMMAND OPTIONS USING C OFF;\nLOCK TABLE orders IN EXCLUSIVE MODE;\nCALL DBMS_ALERT.SLEEP(1.5);\nCOMMIT;\n', lockRe: /lock: X on orders held ~1\.\d\d s \(\d+ poll\(s\)\), over the 0\.5 s budget/,
    drop: "ALTER TABLE orders DROP COLUMN note;\nCALL SYSPROC.ADMIN_CMD('REORG TABLE orders');\n",
    dump: "CREATE TABLE users (id INTEGER NOT NULL PRIMARY KEY, email VARCHAR(100) NOT NULL);\nALTER TABLE missing_table ADD COLUMN x INTEGER;\nINSERT INTO users VALUES (1, 'a@example.com'), (2, 'b@example.com');\nCOMMIT;\n",
    dumpError: /SQL0204N\n/,
    up: "-- migrate:up\nALTER TABLE users ADD COLUMN nickname VARCHAR(50);\nUPDATE users SET nickname = SUBSTR(email, 1, LOCATE('@', email) - 1);\n-- migrate:down\nALTER TABLE users DROP COLUMN nickname;\nCALL SYSPROC.ADMIN_CMD('REORG TABLE users');\n",
    bad: 'ALTER TABLE no_such_table ADD COLUMN x INTEGER;\n', badRe: /SQL0204N/, after: 'ALTER TABLE users ADD COLUMN y INTEGER;\n',
  },
  mssql: {
    seed: join(FIXTURES, 'seed-mssql.sql'), add: 'ALTER TABLE orders ADD due_on date NULL;\n',
    lock: "BEGIN TRANSACTION;\nSELECT 1 FROM orders WITH (TABLOCKX, HOLDLOCK);\nWAITFOR DELAY '00:00:01.5';\nCOMMIT TRANSACTION;\n", lockRe: /lock: X on orders held ~1\.\d\d s \(\d+ poll\(s\)\), over the 0\.5 s budget/,
    drop: 'ALTER TABLE orders DROP COLUMN note;\n',
    dump: 'CREATE TABLE users (id int PRIMARY KEY, email nvarchar(100) NOT NULL);\nGO\nALTER TABLE missing_table ADD x int;\nGO\nINSERT INTO users VALUES (1, N\'a@example.com\'), (2, N\'b@example.com\');\nGO\n',
    dumpError: /Msg 4902 at line 1\n/,
    up: "-- migrate:up\nALTER TABLE users ADD nickname nvarchar(50) NULL;\nGO\nUPDATE users SET nickname = LEFT(email, CHARINDEX('@', email) - 1);\n-- migrate:down\nALTER TABLE users DROP COLUMN nickname;\n", runner: /goose|dbmate/,
    bad: 'ALTER TABLE no_such_table ADD x int;\n', after: 'ALTER TABLE users ADD y int;\n',
  },
};
const familyOf = (engine) => ({ mariadb: 'mysql' }[engine.split(':')[0]] ?? engine.split(':')[0]);

for (const engine of ENGINES) {
  const family = familyOf(engine);
  const sc = SCENARIOS[family];
  const label = engine;
  if (!sc) continue;

  test(`${label}: ups report diffs and locks, a lock over the budget and a lossy migration fail, the container is removed`, { skip, timeout: 1500000 }, (t) => {
    const dir = scratch(t);
    const add = put(dir, '0001_add.sql', sc.add);
    const lock = put(dir, '0002_lock.sql', sc.lock);
    const drop = put(dir, '0003_drop.sql', sc.drop);
    const r = cli(['--engine', engine, sc.seed, add, lock, drop, '--lock-budget', '0.5']);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, new RegExp(`engine .*${engine.split(':')[1].replace(/\W/g, '.')} in container msafe-rehearse-`));
    assert.match(r.out, /seed: .* loaded in .* \(2 table\(s\), 7 row\(s\)\)/);
    assert.match(r.out, /ran\s+up\s.*0001_add\.sql in \d+ ms\n\s+orders\s+rows 4\s+columns: \+due_on\n\s+users\s+rows 3/);
    assert.match(r.out, /LOCKED\s+up\s.*0002_lock\.sql/);
    assert.match(r.out, sc.lockRe);
    assert.match(r.out, /LOST\s+up\s.*0003_drop\.sql/);
    assert.match(r.out, /lost: orders\.note dropped with 2 non-NULL value\(s\)/);
    assert.match(r.out, /3 up\(s\) on .*: 2 problem\(s\)/);
    // the duration is read inside the server: a 1.5 s sleep takes 1.5 s whatever the docker round trip costs
    assert.match(r.out, /0002_lock\.sql in (1[4-9]\d\d|2[0-4]\d\d) ms/);
    assert.match(r.out, /polled every ~\d+ ms/);
    assert.ok(!/no write lock over/.test(r.out), 'a run with problems never claims there was no lock');
    const name = containerOf(r.out);
    assert.ok(name, 'the container name is printed');
    assert.ok(!exists(name), `${name} must be removed`);
  });

  test(`${label}: --dump loads tolerating errors; --down runs up, down, up; a lock inside the budget passes`, { skip, timeout: 1500000 }, (t) => {
    const dir = scratch(t);
    const dump = put(dir, 'dump.sql', sc.dump);
    const up = put(dir, '0001_nick.sql', sc.up);
    const extra = (sc.extra ?? []).map(([n, body]) => put(dir, n, body));
    const r = cli(['--engine', engine, '--dump', dump, up, ...extra, '--down']);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /runner: (goose|dbmate)/);
    assert.match(r.out, new RegExp(`seed: the dump loaded with 1 error line\\(s\\), first ${sc.dumpError.source}`));
    assert.ok(!/no_such_role|missing_table/.test(r.out), 'the text of a dump error can quote data and is not printed');
    if (extra.length) assert.match(r.out, /ran\s+up\s.*0002_proc\.sql/);
    assert.match(r.out, /\(1 table\(s\), 2 row\(s\)\)/);
    assert.match(r.out, /ran\s+up\s[^]*?columns: \+nickname/);
    assert.match(r.out, /ran\s+down\s[^]*?columns: -nickname \(2 non-NULL\)/);
    assert.match(r.out, /after the down\(s\) the tables and columns match the seed/);
    const n = 1 + extra.length;
    assert.match(r.out, new RegExp(`${n} up\\(s\\), ${n} down\\(s\\) on .*all ran, no rows or values lost, no write lock over 2 s`));
    assert.ok(!exists(containerOf(r.out)));
  });

  test(`${label}: a failing migration stops the rest and the container is still removed`, { skip, timeout: 1500000 }, (t) => {
    const dir = scratch(t);
    const bad = put(dir, '0001_bad.sql', sc.bad);
    const after = put(dir, '0002_after.sql', sc.after);
    const r = cli(['--engine', engine, sc.seed, bad, after]);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, new RegExp(`FAILED\\s+up\\s.*0001_bad\\.sql: .*${(sc.badRe ?? /no_such_table/i).source}`, 'i'));
    assert.match(r.out, /SKIPPED up\s.*0002_after/);
    assert.ok(!/ran\s+up/.test(r.out));
    assert.ok(!exists(containerOf(r.out)));
  });
}

const oraEngine = ENGINES.find((e) => e.startsWith('oracle:'));
if (oraEngine) {
  test(`${oraEngine}: SE2 is not emulated and the run says so; ONLINE passes on Free, a PL/SQL block and DDL implicit commits are handled`, { skip, timeout: 2400000 }, (t) => {
    const dir = scratch(t);
    const online = put(dir, '0001_idx.sql', 'CREATE INDEX ix_orders_note ON orders (note) ONLINE;\n');
    const block = put(dir, '0002_block.sql', "BEGIN\n  EXECUTE IMMEDIATE 'ALTER TABLE orders ADD (flag NUMBER)';\nEND;\n/\n");
    const r = cli(['--engine', oraEngine, SCENARIOS.oracle.seed, online, block]);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /edition: --edition se2 is not emulated: Oracle Free has the Enterprise Edition features/);
    assert.match(r.out, /ran\s+up\s.*0001_idx\.sql/);
    assert.match(r.out, /ran\s+up\s.*0002_block\.sql in \d+ ms\n\s+orders\s+rows 4\s+columns: \+flag/);
    assert.ok(!exists(containerOf(r.out)));
    assert.notEqual(spawnSync('docker', ['network', 'inspect', containerOf(r.out)], { stdio: 'ignore', windowsHide: true }).status, 0, 'the private network is removed with the container');
    const failing = put(dir, '0003_fail.sql', 'ALTER TABLE orders ADD (a NUMBER);\nALTER TABLE no_such ADD (b NUMBER);\n');
    const f = cli(['--engine', oraEngine, SCENARIOS.oracle.seed, failing]);
    t.after(() => { const n = containerOf(f.out); if (n) remove(n); });
    assert.equal(f.code, 1, f.out + f.err);
    assert.match(f.out, /statements before the failing one stay applied: Oracle DDL commits implicitly/);
  });
}

const db2Engine = ENGINES.find((e) => e.startsWith('db2:'));
if (db2Engine) {
  test(`${db2Engine}: a migration that leaves a table REORG-pending fails, one that runs the REORG passes`, { skip, timeout: 3600000 }, (t) => {
    const dir = scratch(t);
    const drop = put(dir, '0001_drop.sql', 'ALTER TABLE orders DROP COLUMN note;\n');
    const r = cli(['--engine', db2Engine, '--allow-loss', 'orders.note', SCENARIOS.db2.seed, drop]);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /PENDING\s+up\s.*0001_drop\.sql/);
    assert.match(r.out, /REORG PENDING: orders is unusable until a classic REORG TABLE completes/);
    assert.ok(!exists(containerOf(r.out)));
    const fixed = put(dir, '0002_drop.sql', "ALTER TABLE orders DROP COLUMN note;\nCALL SYSPROC.ADMIN_CMD('REORG TABLE orders');\n");
    const ok = cli(['--engine', db2Engine, '--allow-loss', 'orders.note', SCENARIOS.db2.seed, fixed]);
    t.after(() => { const n = containerOf(ok.out); if (n) remove(n); });
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.ok(!/REORG PENDING/.test(ok.out));
  });
}

const msEngine = ENGINES.find((e) => e.startsWith('mssql:'));
if (msEngine) {
  test(`${msEngine}: --edition standard runs a non-Enterprise edition (ONLINE fails), --edition enterprise runs Developer (ONLINE works)`, { skip, timeout: 2400000 }, (t) => {
    const dir = scratch(t);
    const online = put(dir, '0001_idx.sql', 'CREATE INDEX ix_orders_note ON orders (user_id) WITH (ONLINE = ON);\n');
    const std = cli(['--engine', msEngine, SCENARIOS.mssql.seed, online]);
    t.after(() => { const n = containerOf(std.out); if (n) remove(n); });
    assert.equal(std.code, 1, std.out + std.err);
    assert.match(std.out, /edition: (Express|Standard)/);
    assert.match(std.out, /FAILED\s+up\s.*0001_idx\.sql/);
    const ent = cli(['--engine', msEngine, '--edition', 'enterprise', SCENARIOS.mssql.seed, online]);
    t.after(() => { const n = containerOf(ent.out); if (n) remove(n); });
    assert.equal(ent.code, 0, ent.out + ent.err);
    assert.match(ent.out, /edition: Developer/);
    assert.match(ent.out, /ran\s+up\s.*0001_idx\.sql/);
    assert.ok(!exists(containerOf(std.out)) && !exists(containerOf(ent.out)));
  });
}

const pgEngine = ENGINES.find((e) => e.startsWith('postgres'));
if (pgEngine) {
  test(`${pgEngine}: the runner's transaction wrapping is honoured, and --keep leaves the container with removal instructions`, { skip, timeout: 900000 }, (t) => {
    const dir = scratch(t);
    const wrapped = put(dir, '0001_idx.sql', '-- +goose Up\nCREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);\n-- +goose Down\nDROP INDEX CONCURRENTLY idx_orders_user;\n');
    const r = cli(['--engine', pgEngine, PG_SEED, wrapped, '--keep']);
    const name = containerOf(r.out);
    t.after(() => { if (name) remove(name); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /FAILED\s+up\s.*cannot run inside a transaction block/);
    assert.ok(name && exists(name), 'a finished run that found problems keeps the container with --keep');
    assert.match(r.out, new RegExp(`docker rm -f -v ${name}`));
    remove(name);

    const free = put(dir, '0002_idx.sql', '-- +goose Up\n-- +goose NO TRANSACTION\nCREATE INDEX CONCURRENTLY idx_orders_user ON orders (user_id);\n-- +goose Down\n-- +goose NO TRANSACTION\nDROP INDEX CONCURRENTLY idx_orders_user;\n');
    const kept = cli(['--engine', pgEngine, PG_SEED, free, '--down', '--keep']);
    const keptName = containerOf(kept.out);
    t.after(() => { if (keptName) remove(keptName); });
    assert.equal(kept.code, 0, kept.out + kept.err);
    assert.match(kept.out, /ran\s+up\s/);
    assert.match(kept.out, /ran\s+down\s/);
    assert.ok(exists(keptName), 'the container is kept');
    assert.match(kept.out, new RegExp(`container ${keptName} kept for inspection`));
    assert.match(kept.out, new RegExp(`docker rm -f -v ${keptName}`));
    const check = spawnSync('docker', ['exec', '-e', 'PGPASSWORD=msafe', keptName, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'rehearsal', '-Atc', 'SELECT count(*) FROM orders'], { encoding: 'utf8', windowsHide: true });
    assert.equal(check.stdout.trim(), '4');
    const net = spawnSync('docker', ['inspect', '-f', '{{.HostConfig.NetworkMode}}', keptName], { encoding: 'utf8', windowsHide: true });
    assert.equal(net.stdout.trim(), 'none', 'a kept container holding a dump is not reachable from other containers');
  });

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    test(`${pgEngine}: a run that receives ${signal} exits ${code} and removes its container`, { skip: skip || (process.platform === 'win32' ? `skipped: a child process cannot be sent ${signal} on Windows` : false), timeout: 900000 }, async (t) => {
      const dir = scratch(t);
      const slow = put(dir, '0001_slow.sql', 'SELECT pg_sleep(120);\n');
      const child = spawn(process.execPath, [REHEARSE_ANY, '--engine', pgEngine, PG_SEED, slow], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
      const exited = new Promise((resolve) => child.on('close', (c, s) => resolve({ code: c, signal: s })));
      const started = Date.now();
      while (!/seed: /.test(out) && Date.now() - started < 600000) await new Promise((r) => setTimeout(r, 500));
      const name = containerOf(out);
      t.after(() => { if (name) remove(name); });
      assert.ok(name, out);
      child.kill(signal);
      const end = await exited;
      assert.equal(end.code, code, JSON.stringify(end));
      assert.ok(!exists(name), `${name} must be removed after ${signal}`);
    });
  }

  test(`${pgEngine}: a .sql.gz seed is unpacked, and a seed or dump that leaves no tables is exit 2`, { skip, timeout: 900000 }, (t) => {
    const dir = scratch(t);
    const up = put(dir, '0001_add.sql', 'ALTER TABLE users ADD COLUMN flag int;\n');
    const gz = join(dir, 'seed.sql.gz');
    writeFileSync(gz, gzipSync(readFileSync(PG_SEED)));
    const loaded = cli(['--engine', pgEngine, gz, up]);
    t.after(() => { const n = containerOf(loaded.out); if (n) remove(n); });
    assert.equal(loaded.code, 0, loaded.out + loaded.err);
    assert.match(loaded.out, /\(2 table\(s\), 7 row\(s\)\)/);
    assert.match(loaded.out, /users\s+rows 3\s+columns: \+flag/);

    const empty = put(dir, 'empty-seed.sql', 'SELECT 1;\n');
    const none = cli(['--engine', pgEngine, empty, up]);
    assert.equal(none.code, 2, none.out + none.err);
    assert.match(none.err, /left the database with no tables/);

    const allFail = put(dir, 'broken-dump.sql', 'ALTER TABLE nothing ADD COLUMN x int;\nINSERT INTO nothing VALUES (1);\n');
    const dumped = cli(['--engine', pgEngine, '--dump', allFail, up]);
    assert.equal(dumped.code, 2, dumped.out + dumped.err);
    assert.match(dumped.err, /left the database with no tables/);
    for (const r of [none, dumped]) assert.ok(!exists(containerOf(r.out)));
  });

  test(`${pgEngine}: tables of every schema are snapshotted and their locks reported`, { skip, timeout: 900000 }, (t) => {
    const dir = scratch(t);
    const seed = put(dir, 'seed.sql', "CREATE SCHEMA app;\nCREATE TABLE app.orders (id int PRIMARY KEY, note text);\nINSERT INTO app.orders VALUES (1, 'a'), (2, 'b');\nCREATE TABLE users (id int PRIMARY KEY);\n");
    const lock = put(dir, '0001_lock.sql', 'BEGIN;\nLOCK TABLE app.orders IN ACCESS EXCLUSIVE MODE;\nSELECT pg_sleep(1.5);\nCOMMIT;\n');
    const drop = put(dir, '0002_drop.sql', 'ALTER TABLE app.orders DROP COLUMN note;\n');
    const r = cli(['--engine', pgEngine, seed, lock, drop, '--lock-budget', '0.5']);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /\(2 table\(s\), 2 row\(s\)\)/);
    assert.match(r.out, /app\.orders\s+rows 2/);
    assert.match(r.out, /lock: AccessExclusiveLock on app\.orders held ~1\.\d\d s/);
    assert.match(r.out, /lost: app\.orders\.note dropped with 2 non-NULL value\(s\)/);
  });

  test(`${pgEngine}: a polling session that dies mid-run means locks are not measured, and the run fails`, { skip, timeout: 900000 }, (t) => {
    const dir = scratch(t);
    const kill = put(dir, '0001_kill_poller.sql', "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'msafe-poller';\nSELECT pg_sleep(1);\n");
    const slow = put(dir, '0002_slow.sql', 'ALTER TABLE users ADD COLUMN flag int;\nSELECT pg_sleep(1);\n');
    const r = cli(['--engine', pgEngine, PG_SEED, kill, slow]);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /lock: NOT MEASURED/);
    assert.match(r.out, /locks not measured for 2 migration\(s\)/);
    assert.ok(!/no write lock over/.test(r.out) && !/no write-blocking lock seen/.test(r.out), r.out);
  });

  test(`${pgEngine}: containers left by killed runs are removed at the next start, live ones are not`, { skip, timeout: 600000 }, (t) => {
    const finished = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(finished.stdout);
    const abandoned = `msafe-rehearse-${deadPid}-aaaaaa`;
    const running = `msafe-rehearse-${process.pid}-bbbbbb`;
    for (const n of [abandoned, running]) {
      const r = spawnSync('docker', ['run', '-d', '--label', 'msafe-rehearse=1', '--name', n, '--network', 'none', 'alpine:latest', 'sleep', '600'], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr);
      t.after(() => remove(n));
    }
    const up = put(scratch(t), '0001.sql', 'SELECT 1;\n');
    const r = cli(['--engine', 'postgres:msafe-no-such-tag-0000', PG_SEED, up]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /removed 1 rehearsal container\(s\) left behind by runs that were killed/);
    assert.ok(!exists(abandoned), 'the abandoned container is removed');
    assert.ok(exists(running), 'a container whose process is alive is left alone');
  });
}

test('an image that does not exist on the registry is exit 2 when docker is available', { skip, timeout: 300000 }, (t) => {
  const dir = scratch(t);
  const up = put(dir, '0001.sql', 'SELECT 1;\n');
  const r = cli(['--engine', 'postgres:msafe-no-such-tag-0000', PG_SEED, up]);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /could not run: cannot pull postgres:msafe-no-such-tag-0000/);
});
