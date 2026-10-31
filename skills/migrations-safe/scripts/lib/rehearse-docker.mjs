// Rehearses migrations on a throwaway PostgreSQL, MySQL or MariaDB container. The database is reached only
// through `docker exec <container> psql|mysql`, so nothing but the docker CLI is needed on the host.
// It reports per migration the duration, the write-blocking locks it held (polled from a second session),
// and the same row and column diff as the SQLite rehearsal.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { createGunzip, gunzipSync } from 'node:zlib';
import { decodeSql, parse } from './parse.mjs';
import { RUNNER_IDS, detectRunner, profileOf, wrapsFile } from './runners.mjs';
import { RehearsalUsageError, diff, partFor } from './rehearse.mjs';

export const ENGINE_KINDS = ['postgres', 'mysql', 'mariadb'];
export const DEFAULT_LOCK_BUDGET_MS = 2000;
export const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const PASSWORD = 'msafe';
const DATABASE = 'rehearsal';
const POLL_PAUSE_MS = 40;
const TMPFS_SEED_LIMIT = 256 * 1024 * 1024;
const MIGRATION_APP = 'msafe-migration';
const PROBE_TABLE = 'msafe_probe';

export const parseEngine = (spec) => {
  const [kind, ...rest] = String(spec).split(':');
  const tag = rest.join(':');
  if (!ENGINE_KINDS.includes(kind) || !tag) throw new RehearsalUsageError(`--engine takes sqlite, postgres:<tag>, mysql:<tag> or mariadb:<tag> (got "${String(spec).slice(0, 40)}")`);
  return { kind, tag, image: `${kind}:${tag}` };
};

// "2" and "2s" are seconds, "500ms" milliseconds.
export const parseDuration = (text) => {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!m) throw new RehearsalUsageError(`--lock-budget takes a duration such as 2, 2s or 500ms (got "${String(text).slice(0, 20)}")`);
  return Number(m[1]) * (m[2]?.toLowerCase() === 'ms' ? 1 : 1000);
};

// Size the seed will have once read: a .gz file by the length recorded in its last four bytes.
export const seedBytes = (file) => {
  const size = statSync(file).size;
  if (!/\.gz$/i.test(file) || size < 4) return size;
  const fd = openSync(file, 'r');
  try {
    const tail = Buffer.alloc(4);
    readSync(fd, tail, 0, 4, size - 4);
    return Math.max(size, tail.readUInt32LE(0));
  } finally { closeSync(fd); }
};

// ── docker ───────────────────────────────────────────────────────────────────────────────────────

const docker = (args, { input, stream, timeoutMs = 600000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  const timer = setTimeout(() => { child.kill(); reject(new RehearsalUsageError(`docker ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
  child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  child.stdin.on('error', () => { /* the client exited before reading everything: its exit code says why */ });
  if (stream) {
    stream.on('error', (e) => { child.kill(); reject(e); });
    stream.pipe(child.stdin);
  } else child.stdin.end(input ?? '');
});

const firstLines = (text, n = 3) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n).join(' | ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Containers of this tool are named msafe-rehearse-<pid>-<id>. A run that is killed without a chance to clean
// up (TerminateProcess, a CI cancel) leaves its container; the next run removes the ones whose pid is gone.
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const sweepAbandoned = async (print) => {
  const listed = await docker(['ps', '-a', '--filter', 'label=msafe-rehearse=1', '--format', '{{.Names}}'], { timeoutMs: 60000 });
  if (listed.code !== 0) return;
  const dead = listed.out.split(/\r?\n/).map((n) => n.trim()).filter((n) => {
    const pid = Number(n.match(/^msafe-rehearse-(\d+)-/)?.[1]);
    return pid && pid !== process.pid && !pidAlive(pid);
  });
  for (const n of dead) await docker(['rm', '-f', '-v', n], { timeoutMs: 120000 });
  if (dead.length) print(`removed ${dead.length} rehearsal container(s) left behind by runs that were killed`);
};

const live = new Set();
let hooked = false;
const removeSync = (name) => spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', windowsHide: true });
const hookExit = () => {
  if (hooked) return;
  hooked = true;
  const cleanUp = () => { for (const n of live) removeSync(n); live.clear(); };
  process.on('exit', cleanUp);
  for (const [sig, code] of Object.entries(SIGNAL_EXIT)) process.on(sig, () => { cleanUp(); process.exit(code); });
};

const ensureDocker = async () => {
  let r;
  try {
    r = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30000 });
  } catch (e) {
    throw new RehearsalUsageError(e.code === 'ENOENT' ? 'docker is not available: the `docker` command was not found in PATH' : `docker is not available: ${e.message}`);
  }
  if (r.code !== 0) throw new RehearsalUsageError(`docker is not available: the daemon did not answer (${firstLines(r.err, 2) || `exit ${r.code}`})`);
};

const ensureImage = async (image, print) => {
  const have = await docker(['image', 'inspect', image], { timeoutMs: 60000 });
  if (have.code === 0) return;
  print(`pulling ${image} ...`);
  const pulled = await docker(['pull', image], { timeoutMs: 1800000 });
  if (pulled.code !== 0) throw new RehearsalUsageError(`cannot pull ${image}: ${firstLines(pulled.err, 2) || `exit ${pulled.code}`}`);
};

// ── engines ──────────────────────────────────────────────────────────────────────────────────────

const pgQuote = (id) => `"${id.replaceAll('"', '""')}"`;
const pgLiteral = (s) => `'${s.replaceAll("'", "''")}'`;
const myQuote = (id) => `\`${id.replaceAll('`', '``')}\``;
const myLiteral = (s) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const GEOMETRY = /^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i;
const lockList = (modes) => modes.map((m) => `'${m}'`).join(', ');

const PG_LOCKS = ['AccessExclusiveLock', 'ExclusiveLock', 'ShareRowExclusiveLock', 'ShareLock'];
const MY_LOCKS = ['EXCLUSIVE', 'SHARED_NO_WRITE', 'SHARED_NO_READ_WRITE', 'SHARED_READ_ONLY'];
const pollSqlPg = `SELECT l.mode || E'\\t' || n.nspname || '.' || c.relname FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace WHERE l.locktype = 'relation' AND l.granted AND c.relkind IN ('r', 'p') AND a.application_name = '${MIGRATION_APP}' AND l.mode IN (${lockList(PG_LOCKS)}) AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%';`;
const pollSqlMysql = `SELECT CONCAT(m.LOCK_TYPE, '\\t', m.OBJECT_NAME) FROM performance_schema.metadata_locks m WHERE m.OBJECT_TYPE = 'TABLE' AND m.OBJECT_SCHEMA = '${DATABASE}' AND m.LOCK_STATUS = 'GRANTED' AND m.LOCK_TYPE IN (${lockList(MY_LOCKS)}) AND m.OWNER_THREAD_ID <> (SELECT t.THREAD_ID FROM performance_schema.threads t WHERE t.PROCESSLIST_ID = CONNECTION_ID());`;
const pollSqlMaria = `SELECT CONCAT(REPLACE(LOCK_MODE, 'MDL_', ''), '\\t', TABLE_NAME) FROM information_schema.METADATA_LOCK_INFO WHERE TABLE_SCHEMA = '${DATABASE}' AND LOCK_MODE IN (${lockList(MY_LOCKS.map((m) => `MDL_${m}`))}) AND THREAD_ID <> CONNECTION_ID();`;

// The statements a MySQL client runs: every statement ends with `;;`, so compound statements (procedures
// from goose StatementBegin/End) keep their inner semicolons. A file that sets its own DELIMITER is sent as it is.
export const mysqlInput = (sql, { wrap, marks }) => {
  if (/^\s*delimiter\b/im.test(sql)) return { input: wrap ? `START TRANSACTION;\n${sql}\nCOMMIT;\n` : sql, marked: false };
  const statements = parse(sql, { dialect: 'mysql' }).statements.map((s) => s.text);
  const mark = (tag) => `SELECT CONCAT('@@${tag} ', UNIX_TIMESTAMP(SYSDATE(6)));;\n`;
  const body = `DELIMITER ;;\n${marks ? mark('T0') : ''}${statements.map((s) => `${s};;\n`).join('')}${marks ? mark('T1') : ''}DELIMITER ;\n`;
  return { input: wrap ? `START TRANSACTION;\n${body}COMMIT;\n` : body, marked: marks };
};

// One engine per run; `base(container, ...)` is the docker exec prefix up to the client's output flags.
export const makeEngine = ({ kind, image }) => {
  if (kind === 'postgres') {
    const base = (c, { app } = {}) => ['exec', '-i', '-e', `PGPASSWORD=${PASSWORD}`, ...(app ? ['-e', `PGAPPNAME=${app}`] : []), c,
      'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', DATABASE, '-X', '-q', '-A', '-t', '-F', '\t'];
    const mark = (tag) => `SELECT '@@${tag} ' || extract(epoch from clock_timestamp());\n`;
    return {
      kind, image, label: 'PostgreSQL', dialect: 'postgres',
      runArgs: ({ tmpfs }) => [...(tmpfs ? ['--tmpfs', '/var/lib/postgresql/data', '-e', 'PGDATA=/var/lib/postgresql/data/pgdata'] : []), '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', `POSTGRES_DB=${DATABASE}`, image, 'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
      setup: async () => null,
      base,
      readyArgs: (c) => [...base(c), '-c', 'SELECT 1'],
      scriptArgs: (c, { app, stopOnError, wrap }) => [...base(c, { app }), ...(stopOnError ? ['-v', 'ON_ERROR_STOP=1'] : []), ...(wrap ? ['-1'] : []), '-f', '-'],
      // an empty statement after the file ends a last statement that lacks its semicolon
      scriptInput: (sql, { marks }) => ({ input: marks ? `${mark('T0')}${sql}\n;\n${mark('T1')}` : sql, marked: marks }),
      queryArgs: (c) => [...base(c), '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      pollerArgs: (c) => [...base(c, { app: 'msafe-poller' }), '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      pollInput: () => `${pollSqlPg}\n\\echo @@END\n`,
      errorLines: (stderr) => stderr.split(/\r?\n/).filter((l) => /\bERROR:/.test(l)),
      // statement number only: an error text can quote row data
      describeError: (line) => `at line ${line.match(/:(\d+): ERROR/)?.[1] ?? '?'}`,
      metaSql: "SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY n.nspname, c.relname, a.attnum;",
      tableKey: (schema, table) => (schema === 'public' ? table : `${schema}.${table}`),
      statsSql: (key, { schema, name }, cols) => `SELECT row_to_json(x)::text FROM (SELECT ${pgLiteral(key)} AS t, count(*) AS n${cols.map((c, i) => `, count(${pgQuote(c.name)}) AS c${i}, count(DISTINCT ${pgQuote(c.name)}::text) AS d${i}, coalesce(sum(length(${pgQuote(c.name)}::text)), 0) AS l${i}, min(${pgQuote(c.name)}::text) AS lo${i}, max(${pgQuote(c.name)}::text) AS hi${i}`).join('')} FROM ${pgQuote(schema)}.${pgQuote(name)}) x;`,
      normalizeLockTable: (t) => t.replace(/^public\./, ''),
      shell: (c) => `docker exec -it -e PGPASSWORD=${PASSWORD} ${c} psql -h 127.0.0.1 -U postgres ${DATABASE}`,
      probe: {
        create: `CREATE TABLE ${PROBE_TABLE} (id int);`, drop: `DROP TABLE ${PROBE_TABLE};`,
        hold: `BEGIN;\nLOCK TABLE ${PROBE_TABLE} IN ACCESS EXCLUSIVE MODE;\nSELECT pg_sleep(3);\nCOMMIT;\n`,
      },
    };
  }
  const maria = kind === 'mariadb';
  const eng = {
    kind, image, label: maria ? 'MariaDB' : 'MySQL', dialect: 'mysql', bin: 'mysql',
    runArgs: ({ tmpfs }) => [...(tmpfs ? ['--tmpfs', '/var/lib/mysql'] : []), '-e', `${maria ? 'MARIADB' : 'MYSQL'}_ROOT_PASSWORD=${PASSWORD}`, '-e', `${maria ? 'MARIADB' : 'MYSQL'}_DATABASE=${DATABASE}`, image],
    base: (c, extra = []) => ['exec', '-i', '-e', `MYSQL_PWD=${PASSWORD}`, c, eng.bin, '-h127.0.0.1', '-uroot', '--batch', '--raw', '--skip-column-names', '--default-character-set=utf8mb4', '-D', DATABASE, ...extra],
    readyArgs: (c) => eng.base(c, ['-e', 'SELECT 1']),
    scriptArgs: (c, { stopOnError }) => eng.base(c, stopOnError ? [] : ['--force']),
    scriptInput: (sql, { wrap, marks }) => mysqlInput(sql, { wrap, marks }),
    queryArgs: (c) => eng.base(c),
    pollerArgs: (c) => eng.base(c, ['--unbuffered']),
    pollInput: () => `${maria ? pollSqlMaria : pollSqlMysql}\nSELECT '@@END';\n`,
    errorLines: (stderr) => stderr.split(/\r?\n/).filter((l) => /^ERROR \d+/.test(l)),
    describeError: (line) => line.match(/^(ERROR \d+(?: \(\w+\))?)(?: at line (\d+))?/)?.slice(1).filter(Boolean).join(' at line ') ?? 'ERROR',
    metaSql: `SELECT '', c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;`,
    tableKey: (schema, table) => table,
    statsSql: (key, { name }, cols) => `SELECT JSON_OBJECT('t', ${myLiteral(key)}, 'n', COUNT(*)${cols.map((c, i) => {
      const v = GEOMETRY.test(c.type) ? `ST_AsText(${myQuote(c.name)})` : `CAST(${myQuote(c.name)} AS CHAR)`;
      return `, 'c${i}', COUNT(${myQuote(c.name)}), 'd${i}', COUNT(DISTINCT ${myQuote(c.name)}), 'l${i}', COALESCE(SUM(LENGTH(${v})), 0), 'lo${i}', MIN(${v}), 'hi${i}', MAX(${v})`;
    }).join('')}) FROM ${myQuote(name)};`,
    normalizeLockTable: (t) => t,
    shell: (c) => `docker exec -it ${c} ${eng.bin} -h127.0.0.1 -uroot -p${PASSWORD} ${DATABASE}`,
    // Newer MariaDB images ship `mariadb` without the `mysql` name.
    detect: async (c) => {
      if (eng.binFound) return;
      const found = await docker(['exec', c, 'sh', '-c', 'command -v mariadb || command -v mysql']);
      if (found.code === 0 && found.out.trim()) { eng.bin = found.out.trim().split('/').pop(); eng.binFound = true; }
    },
    // The metadata-lock instrument is off by default in MySQL 5.7, and MariaDB reports locks through a plugin.
    // Returns why locks cannot be read, or null.
    setup: async (c) => {
      const sql = maria ? "INSTALL SONAME 'metadata_lock_info'" : "UPDATE performance_schema.setup_instruments SET ENABLED = 'YES', TIMED = 'YES' WHERE NAME = 'wait/lock/metadata/sql/mdl'";
      const r = await docker(eng.base(c, ['-e', sql]));
      return r.code === 0 ? null : firstLines(r.err || r.out, 2);
    },
    probe: {
      create: `CREATE TABLE ${PROBE_TABLE} (id int) ENGINE=InnoDB;`, drop: `DROP TABLE ${PROBE_TABLE};`,
      hold: `LOCK TABLES ${PROBE_TABLE} WRITE;\nSELECT SLEEP(3);\nUNLOCK TABLES;\n`,
    },
  };
  return eng;
};

// ── a second session that polls the lock tables while a migration runs ───────────────────────────────────

const startPoller = (eng, c) => {
  const child = spawn('docker', eng.pollerArgs(c), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const samples = [];
  let rows = [];
  let buf = '';
  let errText = '';
  const state = { stopped: false, died: false, error: null };
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8').on('data', (d) => { errText += d; state.error = firstLines(errText, 2) || null; });
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '@@END') {
        samples.push({ t: performance.now(), rows });
        rows = [];
        setTimeout(send, POLL_PAUSE_MS);
      } else if (line) rows.push(line.split('\t'));
    }
  });
  child.on('close', () => { if (!state.stopped) state.died = true; });
  function send() { if (!state.stopped && child.stdin.writable) child.stdin.write(eng.pollInput()); }
  send();
  return {
    samples, state,
    stop: () => { state.stopped = true; child.stdin.end(); setTimeout(() => child.kill(), 500).unref(); },
  };
};

// Median gap between polls in a window, in ms.
const pollGap = (window) => {
  const gaps = window.slice(1).map((s, i) => s.t - window[i].t).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : POLL_PAUSE_MS;
};

// Locks seen in [t0, t1]: one entry per table (its modes merged) with how long it was held, to the resolution of the polls.
export const locksIn = (samples, t0, t1, tables, normalize = (t) => t) => {
  const window = samples.filter((s) => s.t >= t0 && s.t <= t1 + 200);
  const gap = pollGap(window);
  const seen = new Map();
  for (const s of window) {
    for (const [mode, raw] of s.rows) {
      const table = normalize(raw);
      if (!tables.has(table)) continue;
      const e = seen.get(table) ?? { table, modes: new Set(), first: s.t, last: s.t, polls: 0 };
      e.modes.add(mode);
      e.last = s.t;
      e.polls = Math.max(e.polls, window.filter((w) => w.rows.some(([m, t]) => normalize(t) === table)).length);
      seen.set(table, e);
    }
  }
  return [...seen.values()].map((e) => ({ table: e.table, modes: [...e.modes].sort(), polls: e.polls, ms: e.last - e.first + gap })).sort((a, b) => b.ms - a.ms);
};

// ── what the database holds ──────────────────────────────────────────────────────────────────────

const rows = (text) => text.split(/\r?\n/).filter(Boolean);

// Runs a client command, returning stdout; a failure is a rehearsal that could not run.
const run = async (args, input, what) => {
  const r = await docker(args, { input });
  if (r.code !== 0) throw new RehearsalUsageError(`${what} failed in the container: ${firstLines(r.err || r.out, 3)}`);
  return r.out;
};

const snapshotOf = async (eng, c) => {
  const meta = await run(eng.queryArgs(c), eng.metaSql, 'reading the schema');
  const tables = new Map();
  for (const [schema, table, name, type] of rows(meta).map((l) => l.split('\t'))) {
    const key = eng.tableKey(schema, table);
    if (!tables.has(key)) tables.set(key, { schema, name: table, cols: [] });
    tables.get(key).cols.push({ name, type });
  }
  const stats = new Map();
  if (tables.size) {
    const out = await run(eng.queryArgs(c), [...tables].map(([key, t]) => eng.statsSql(key, t, t.cols)).join('\n'), 'counting rows');
    for (const line of rows(out)) { try { const o = JSON.parse(line); stats.set(o.t, o); } catch { /* not a result row */ } }
  }
  const snap = new Map();
  for (const [key, t] of tables) {
    const s = stats.get(key) ?? { n: 0 };
    snap.set(key, {
      rows: Number(s.n),
      columns: new Map(t.cols.map((col, i) => [col.name, {
        type: col.type, notnull: false, nonNull: Number(s[`c${i}`] ?? 0),
        fingerprint: [s[`d${i}`], s[`l${i}`], s[`lo${i}`], s[`hi${i}`]].join('|'),
      }])),
    });
  }
  return snap;
};

const waitReady = async (eng, name, timeoutMs) => {
  const t0 = Date.now();
  for (;;) {
    const state = await docker(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 30000 });
    if (state.code === 0 && state.out.trim() === 'false') {
      const logs = await docker(['logs', '--tail', '15', name], { timeoutMs: 30000 });
      throw new RehearsalUsageError(`the ${eng.label} container exited while starting: ${firstLines(`${logs.err}\n${logs.out}`.split(/\r?\n/).slice(-8).join('\n'), 6)}`);
    }
    await eng.detect?.(name);
    const r = await docker(eng.readyArgs(name), { timeoutMs: 30000 });
    if (r.code === 0 && /\b1\b/.test(r.out)) return;
    if (Date.now() - t0 > timeoutMs) throw new RehearsalUsageError(`${eng.label} did not accept connections within ${Math.round(timeoutMs / 1000)} s (${firstLines(r.err, 2)})`);
    await sleep(500);
  }
};

const isPgCustomDump = (file) => {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(5);
    readSync(fd, buf, 0, 5, 0);
    return buf.toString('latin1') === 'PGDMP';
  } finally { closeSync(fd); }
};

// Loads the seed. A `.sql` seed (`.gz` too) must load without errors; a dump (pg_dump, mysqldump, optionally
// .gz) loads with errors tolerated and counted (ownership and extension statements often fail in a scratch
// server). Only the statement position and error code are printed: an error text can quote row data.
const loadSeed = async (eng, name, file, dump, print) => {
  const gz = /\.gz$/i.test(file);
  if (dump && eng.kind === 'postgres' && !gz && isPgCustomDump(file)) {
    const r = await docker(['exec', '-i', '-e', `PGPASSWORD=${PASSWORD}`, name, 'pg_restore', '-h', '127.0.0.1', '-U', 'postgres', '-d', DATABASE, '--no-owner', '--no-privileges'], { stream: createReadStream(file), timeoutMs: 3600000 });
    const errors = r.err.split(/\r?\n/).filter((l) => /error/i.test(l));
    if (r.code !== 0 || errors.length) print(`seed: pg_restore exited ${r.code} with ${errors.length} error line(s)`);
    return;
  }
  const args = eng.scriptArgs(name, { app: 'msafe-seed', stopOnError: !dump, wrap: false });
  let r;
  if (dump) r = await docker(args, { stream: gz ? createReadStream(file).pipe(createGunzip()) : createReadStream(file), timeoutMs: 3600000 });
  else {
    r = await docker(args, { input: decodeSql(gz ? gunzipSync(readFileSync(file)) : readFileSync(file)) });
  }
  if (!dump && r.code !== 0) throw new RehearsalUsageError(`the seed ${file} did not load: ${firstLines(r.err || r.out, 3)}`);
  const errors = eng.errorLines(r.err);
  if (dump && errors.length) print(`seed: the dump loaded with ${errors.length} error line(s), first ${eng.describeError(errors[0])}`);
};

const statementCount = (file, kind, dialect) => parse(partFor(file, kind, dialect).sql, { dialect }).statements.length;

// ── the rehearsal ────────────────────────────────────────────────────────────────────────────────

// opts: { engine, source, dump (boolean), ups, downs, runner, allowLoss, lockBudgetMs, keep, disk, startupTimeoutMs }
export const rehearseDocker = async (opts, print) => {
  const spec = parseEngine(opts.engine);
  const { source, ups, downs = null } = opts;
  if (!source || !ups.length) throw new RehearsalUsageError('a seed (or --dump file) and at least one migration are needed');
  if (opts.runner && !RUNNER_IDS.includes(opts.runner)) throw new RehearsalUsageError(`unknown runner ${opts.runner}`);
  for (const f of [source, ...ups, ...(Array.isArray(downs) ? downs : [])]) if (!existsSync(f)) throw new RehearsalUsageError(`${f} does not exist`);
  const eng = makeEngine(spec);
  const downFiles = downs === 'sections' ? ups : downs;
  if (downs === 'sections') for (const f of ups) if (!partFor(f, 'down', eng.dialect).hasDown) throw new RehearsalUsageError(`${f} has no down section: pass the down files after --down`);
  for (const f of ups) if (statementCount(f, 'up', eng.dialect) === 0) throw new RehearsalUsageError(`${f} has no SQL statements, so there is nothing to rehearse`);
  for (const f of downFiles ?? []) if (statementCount(f, 'down', eng.dialect) === 0) throw new RehearsalUsageError(`the down of ${f} has no SQL statements`);
  const detected = opts.runner ? { id: opts.runner, evidence: '--runner' } : detectRunner(ups[0], { markers: partFor(ups[0], 'up', eng.dialect).markers, fileName: ups[0].split(/[\\/]/).at(-1) });
  const profile = profileOf(detected.id);
  const allowLoss = new Set(opts.allowLoss ?? []);
  const budget = opts.lockBudgetMs ?? DEFAULT_LOCK_BUDGET_MS;
  const seconds = (ms) => (ms / 1000).toFixed(2).replace(/\.?0+$/, '');

  await ensureDocker();
  await sweepAbandoned(print);
  await ensureImage(spec.image, print);

  const name = `msafe-rehearse-${process.pid}-${randomBytes(3).toString('hex')}`;
  hookExit();
  live.add(name);
  let poller = null;
  let finished = false;
  try {
    // Data lives in memory (much faster to initialise and load) unless the seed is too big for that or --disk is given.
    // No network: the database is reached with docker exec only, so a --keep'd copy of production data is not reachable from other containers.
    const tmpfs = opts.disk !== true && seedBytes(source) <= TMPFS_SEED_LIMIT;
    const started = await docker(['run', '-d', '--name', name, '--label', 'msafe-rehearse=1', '--network', 'none', ...eng.runArgs({ tmpfs })], { timeoutMs: 120000 });
    if (started.code !== 0) throw new RehearsalUsageError(`could not start ${spec.image}: ${firstLines(started.err, 2)}`);
    print(`runner: ${profile.label} (${detected.evidence}) · engine ${spec.image} in container ${name}`);
    await waitReady(eng, name, opts.startupTimeoutMs ?? 240000);
    const setupError = await eng.setup(name);
    const t0 = performance.now();
    await loadSeed(eng, name, source, opts.dump === true, print);
    let current = await snapshotOf(eng, name);
    if (current.size === 0) throw new RehearsalUsageError(`the seed ${source} left the database with no tables: nothing to rehearse on`);
    const seeded = [...current.values()].reduce((n, t) => n + t.rows, 0);
    print(`seed: ${source} loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s (${current.size} table(s), ${seeded} row(s))`);
    const start = current;

    // the cost of one docker exec round trip, used only when a migration cannot be timed inside the server
    const trips = [];
    for (let i = 0; i < 3; i++) { const a = performance.now(); await docker(eng.readyArgs(name)); trips.push(performance.now() - a); }
    const overhead = trips.sort((a, b) => a - b)[0];

    // Lock measurement is proven before any migration runs: another session holds a lock on a probe table
    // and the poller must see it. A measurement that cannot be shown to work is not reported as "no lock".
    poller = startPoller(eng, name);
    await run(eng.queryArgs(name), eng.probe.create, 'creating the lock probe table');
    const probeStart = performance.now();
    const holder = docker(eng.scriptArgs(name, { app: MIGRATION_APP, stopOnError: true, wrap: false }), { input: eng.probe.hold });
    let seen = false;
    while (!seen && !poller.state.died && !poller.state.error && performance.now() - probeStart < 20000) {
      seen = poller.samples.some((s) => s.t > probeStart && s.rows.some(([, t]) => eng.normalizeLockTable(t) === PROBE_TABLE));
      if (!seen) await sleep(100);
    }
    await holder;
    await docker(eng.scriptArgs(name, { app: 'msafe-seed', stopOnError: true, wrap: false }), { input: eng.probe.drop });
    if (!seen) throw new RehearsalUsageError(`lock measurement failed its self-test: a lock held on a probe table was not seen by the polling session (${poller.state.error ?? setupError ?? (poller.state.died ? 'the polling session ended' : 'no row returned')}); nothing was measured, so nothing is reported`);

    let failed = 0;
    let unmeasured = 0;
    const apply = async (file, kind) => {
      const part = partFor(file, kind, eng.dialect);
      const wrap = wrapsFile(profile, { noTransaction: part.markers.noTransaction, statements: part.statements });
      const { input, marked } = eng.scriptInput(part.sql, { wrap, marks: true });
      const before = current;
      const a = performance.now();
      const r = await docker(eng.scriptArgs(name, { app: MIGRATION_APP, stopOnError: true, wrap }), { input, timeoutMs: 3600000 });
      const b = performance.now();
      if (r.code !== 0) {
        failed++;
        print(`FAILED  ${kind.padEnd(4)} ${file}: ${firstLines(r.err || r.out, 3)}`);
        if (eng.dialect === 'mysql' && !wrap) print('          statements before the failing one stay applied: MySQL DDL commits implicitly');
        return false;
      }
      // duration measured inside the server, between two marks of the same session
      const t = (tag) => Number(r.out.match(new RegExp(`^@@${tag} ([\\d.]+)`, 'm'))?.[1]);
      const ms = marked && t('T1') >= t('T0') ? (t('T1') - t('T0')) * 1000 : Math.max(0, b - a - overhead);
      current = await snapshotOf(eng, name);
      const { lines, lost } = diff(before, current, kind, allowLoss);
      await sleep(POLL_PAUSE_MS * 2);
      const window = poller.samples.filter((s) => s.t >= a && s.t <= b + 200);
      const held = locksIn(poller.samples, a, b, new Set(before.keys()), eng.normalizeLockTable);
      const over = held.filter((l) => l.ms > budget);
      let notMeasured = null;
      if (poller.state.error) notMeasured = `the polling session reported: ${poller.state.error.slice(0, 120)}`;
      else if (poller.state.died) notMeasured = 'the polling session ended';
      else if (b - a >= 300 && window.length < 2) notMeasured = `${window.length} poll(s) during a ${Math.round(b - a)} ms migration`;
      if (notMeasured) unmeasured++;
      const bad = lost.length || over.length || notMeasured;
      if (bad) failed++;
      print(`${lost.length ? 'LOST   ' : over.length ? 'LOCKED ' : notMeasured ? 'UNMEAS.' : 'ran    '} ${kind.padEnd(4)} ${file} in ${ms.toFixed(0)} ms`);
      lines.forEach((l) => print(`          ${l}`));
      lost.forEach((l) => print(`          lost: ${l}`));
      held.forEach((l) => print(`          lock: ${l.modes.join(' + ')} on ${l.table} held ~${(l.ms / 1000).toFixed(2)} s (${l.polls} poll(s))${l.ms > budget ? `, over the ${seconds(budget)} s budget` : ''}`));
      if (notMeasured) print(`          lock: NOT MEASURED (${notMeasured}): this migration's locks are unknown`);
      else if (!held.length) print(`          lock: no write-blocking lock seen on tables that existed before (polled every ~${Math.round(pollGap(window))} ms)`);
      return true;
    };

    let stopped = null;
    for (const f of ups) if (!await apply(f, 'up')) { stopped = f; break; }
    if (stopped) {
      ups.slice(ups.indexOf(stopped) + 1).forEach((f) => print(`SKIPPED up   ${f}: an earlier migration failed`));
    } else if (downFiles) {
      for (const f of [...downFiles].reverse()) if (!await apply(f, 'down')) { stopped = f; break; }
      if (!stopped) {
        const restored = diff(start, current, 'down', allowLoss).lines.filter((l) => / new, |dropped|columns:/.test(l));
        print(restored.length ? `after the down(s) the schema differs from the seed: ${restored[0].replace(/\s+/g, ' ')}` : 'after the down(s) the tables and columns match the seed');
        for (const f of ups) if (!await apply(f, 'up')) { stopped = f; break; }
      }
    }
    const nDown = downFiles ? downFiles.length : 0;
    const verdict = failed
      ? `${failed} problem(s)${unmeasured ? `, locks not measured for ${unmeasured} migration(s)` : ''}${stopped ? `, stopped at ${stopped}` : ''}`
      : `all ran, no rows or values lost, no write lock over ${seconds(budget)} s`;
    print(`${ups.length} up(s)${nDown ? `, ${nDown} down(s)` : ''} on ${spec.image} seeded from ${source}: ${verdict}`);
    finished = true;
    return failed ? 1 : 0;
  } finally {
    poller?.stop();
    if (opts.keep && finished) {
      live.delete(name);
      print(`container ${name} kept for inspection (password ${PASSWORD}, no network: use docker exec).\n  connect: ${eng.shell(name)}\n  remove:  docker rm -f -v ${name}`);
    } else {
      await docker(['rm', '-f', '-v', name], { timeoutMs: 120000 }).catch(() => {});
      live.delete(name);
      if (opts.keep) print(`the run did not finish, so container ${name} was removed`);
    }
  }
};
