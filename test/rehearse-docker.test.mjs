import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDuration, parseEngine } from '../skills/migrations-safe/scripts/lib/rehearse-docker.mjs';
import { FIXTURES, REHEARSE_ANY, put, scratch } from './helpers.mjs';

// ── unit tests: no docker needed ─────────────────────────────────────────────────────────────────

const cli = (args, { env, cwd } = {}) => {
  const r = spawnSync(process.execPath, [REHEARSE_ANY, ...args], { encoding: 'utf8', env: env ?? process.env, cwd, windowsHide: true, timeout: 600000 });
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
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/docker-fake.mjs" "$@"\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  return dir;
};

const PG_SEED = join(FIXTURES, 'seed-postgres.sql');
const MY_SEED = join(FIXTURES, 'seed-mysql.sql');

test('--engine and --lock-budget values are parsed and validated', () => {
  assert.deepEqual(parseEngine('postgres:16'), { kind: 'postgres', tag: '16', image: 'postgres:16' });
  assert.equal(parseEngine('mariadb:11.4').image, 'mariadb:11.4');
  assert.equal(parseEngine('mysql:8.4').kind, 'mysql');
  for (const bad of ['postgres', 'oracle:19', 'mysql:', '']) assert.throws(() => parseEngine(bad), /--engine takes/);
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
  assert.equal(cli(['--engine', 'oracle:19', PG_SEED, up], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, join(dir, 'missing.sql')], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, up, '--lock-budget', 'soon'], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, up, '--foreign-keys', 'on'], noDocker).code, 2);
  assert.equal(cli(['--engine', 'postgres:16', PG_SEED, up, '--runner', 'nope'], noDocker).code, 2);
  for (const flag of [['--keep'], ['--dump', PG_SEED], ['--lock-budget', '1s'], ['--disk']]) {
    const r = cli(['--engine', 'sqlite', join(FIXTURES, 'seed-sqlite.sql'), up, ...flag]);
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

for (const engine of ENGINES) {
  const pg = engine.startsWith('postgres');
  const seed = pg ? PG_SEED : MY_SEED;
  const label = engine;

  test(`${label}: ups report diffs and locks, a lock over the budget and a lossy migration fail, the container is removed`, { skip, timeout: 900000 }, (t) => {
    const dir = scratch(t);
    const add = put(dir, '0001_add.sql', pg ? 'ALTER TABLE orders ADD COLUMN due_on date;\n' : 'ALTER TABLE orders ADD COLUMN due_on date NULL, ALGORITHM=INSTANT;\n');
    const lock = put(dir, '0002_lock.sql', pg
      ? 'BEGIN;\nLOCK TABLE orders IN ACCESS EXCLUSIVE MODE;\nSELECT pg_sleep(1.5);\nCOMMIT;\n'
      : 'LOCK TABLES orders WRITE;\nSELECT SLEEP(1.5);\nUNLOCK TABLES;\n');
    const drop = put(dir, '0003_drop.sql', 'ALTER TABLE orders DROP COLUMN note;\n');
    const r = cli(['--engine', engine, seed, add, lock, drop, '--lock-budget', '0.5']);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, new RegExp(`engine ${engine} in container msafe-rehearse-`));
    assert.match(r.out, /seed: .* loaded in .* \(2 table\(s\), 7 row\(s\)\)/);
    assert.match(r.out, /ran\s+up\s.*0001_add\.sql in \d+ ms\n\s+orders\s+rows 4\s+columns: \+due_on\n\s+users\s+rows 3/);
    assert.match(r.out, /LOCKED\s+up\s.*0002_lock\.sql/);
    assert.match(r.out, pg ? /lock: AccessExclusiveLock on orders held ~1\.\d\d s \(\d+ poll\(s\)\), over the 0\.5 s budget/ : /lock: SHARED_NO_READ_WRITE on orders held ~1\.\d\d s .*over the 0\.5 s budget/);
    assert.match(r.out, /LOST\s+up\s.*0003_drop\.sql/);
    assert.match(r.out, /lost: orders\.note dropped with 2 non-NULL value\(s\)/);
    assert.match(r.out, /3 up\(s\) on .*: 2 problem\(s\)/);
    const name = containerOf(r.out);
    assert.ok(name, 'the container name is printed');
    assert.ok(!exists(name), `${name} must be removed`);
  });

  test(`${label}: --dump loads tolerating errors; --down runs up, down, up; a lock inside the budget passes`, { skip, timeout: 900000 }, (t) => {
    const dir = scratch(t);
    const dump = put(dir, 'dump.sql', pg
      ? `SET statement_timeout = 0;\nCREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL);\nALTER TABLE users OWNER TO no_such_role;\nCOPY users (id, email) FROM stdin;\n1\ta@example.com\n2\tb@example.com\n\\.\n`
      : "/*!40101 SET NAMES utf8mb4 */;\nCREATE TABLE `users` (`id` int NOT NULL PRIMARY KEY, `email` varchar(100) NOT NULL) ENGINE=InnoDB;\nALTER TABLE `missing_table` ADD COLUMN x int;\nLOCK TABLES `users` WRITE;\nINSERT INTO `users` VALUES (1,'a@example.com'),(2,'b@example.com');\nUNLOCK TABLES;\n");
    const up = pg
      ? put(dir, '0001_nick.sql', '-- +goose Up\nALTER TABLE users ADD COLUMN nickname text;\nUPDATE users SET nickname = split_part(email, \'@\', 1);\n-- +goose Down\nALTER TABLE users DROP COLUMN nickname;\n')
      : put(dir, '0001_nick.sql', "-- migrate:up\nALTER TABLE users ADD COLUMN nickname varchar(50) NULL;\nUPDATE users SET nickname = SUBSTRING_INDEX(email, '@', 1);\n-- migrate:down\nALTER TABLE users DROP COLUMN nickname;\n");
    const r = cli(['--engine', engine, '--dump', dump, up, '--down']);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /runner: (goose|dbmate)/);
    assert.match(r.out, /seed: the dump loaded with 1 error line\(s\)/);
    assert.match(r.out, /\(1 table\(s\), 2 row\(s\)\)/);
    assert.match(r.out, /ran\s+up\s[^]*?columns: \+nickname/);
    assert.match(r.out, /ran\s+down\s[^]*?columns: -nickname \(2 non-NULL\)/);
    assert.match(r.out, /after the down\(s\) the tables and columns match the seed/);
    assert.match(r.out, /1 up\(s\), 1 down\(s\) on .*all ran, no rows or values lost, no write lock over 2 s/);
    assert.ok(!exists(containerOf(r.out)));
  });

  test(`${label}: a failing migration stops the rest and the container is still removed`, { skip, timeout: 900000 }, (t) => {
    const dir = scratch(t);
    const bad = put(dir, '0001_bad.sql', 'ALTER TABLE no_such_table ADD COLUMN x int;\n');
    const after = put(dir, '0002_after.sql', 'ALTER TABLE users ADD COLUMN y int;\n');
    const r = cli(['--engine', engine, seed, bad, after]);
    t.after(() => { const n = containerOf(r.out); if (n) remove(n); });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /FAILED\s+up\s.*0001_bad\.sql: .*no_such_table/);
    assert.match(r.out, /SKIPPED up\s.*0002_after/);
    assert.ok(!/ran\s+up/.test(r.out));
    assert.ok(!exists(containerOf(r.out)));
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
  });

  test(`${pgEngine}: an interrupted run removes its container`, { skip: skip || (process.platform === 'win32' ? 'skipped: a child process cannot be sent SIGINT on Windows' : false), timeout: 900000 }, async (t) => {
    const dir = scratch(t);
    const slow = put(dir, '0001_slow.sql', 'SELECT pg_sleep(120);\n');
    const child = spawn(process.execPath, [REHEARSE_ANY, '--engine', pgEngine, PG_SEED, slow], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const started = Date.now();
    while (!/seed: /.test(out) && Date.now() - started < 600000) await new Promise((r) => setTimeout(r, 500));
    const name = containerOf(out);
    t.after(() => { if (name) remove(name); });
    assert.ok(name, out);
    child.kill('SIGINT');
    const end = await exited;
    assert.equal(end.code, 130, JSON.stringify(end));
    assert.ok(!exists(name), `${name} must be removed after SIGINT`);
  });
}

test('an image that does not exist on the registry is exit 2 when docker is available', { skip, timeout: 300000 }, (t) => {
  const dir = scratch(t);
  const up = put(dir, '0001.sql', 'SELECT 1;\n');
  const r = cli(['--engine', 'postgres:msafe-no-such-tag-0000', PG_SEED, up]);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /could not run: cannot pull postgres:msafe-no-such-tag-0000/);
});
