// Rehearses migrations on a throwaway PostgreSQL, MySQL or MariaDB container. The database is reached only
// through `docker exec <container> psql|mysql`, so nothing but the docker CLI is needed on the host.
// It reports per migration the duration, the write-blocking locks it held (polled from a second session),
// and the same row and column diff as the SQLite rehearsal.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { decodeSql, parse } from './parse.mjs';
import { RUNNER_IDS, detectRunner, profileOf, wrapsFile } from './runners.mjs';
import { RehearsalUsageError, diff, partFor } from './rehearse.mjs';

export const ENGINE_KINDS = ['postgres', 'mysql', 'mariadb'];
export const DEFAULT_LOCK_BUDGET_MS = 2000;
const PASSWORD = 'msafe';
const DATABASE = 'rehearsal';
const POLL_PAUSE_MS = 40;
const TMPFS_SEED_LIMIT = 256 * 1024 * 1024;
const MIGRATION_APP = 'msafe-migration';

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

const live = new Set();
let hooked = false;
const removeSync = (name) => spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', windowsHide: true });
const hookExit = () => {
  if (hooked) return;
  hooked = true;
  const cleanUp = () => { for (const n of live) removeSync(n); live.clear(); };
  process.on('exit', cleanUp);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanUp(); process.exit(130); });
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

// One engine per run; `base(container, { app })` is the docker exec prefix up to the client's output flags.
const makeEngine = ({ kind, image }) => {
  if (kind === 'postgres') {
    const base = (c, { app } = {}) => ['exec', '-i', '-e', `PGPASSWORD=${PASSWORD}`, ...(app ? ['-e', `PGAPPNAME=${app}`] : []), c,
      'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', DATABASE, '-X', '-q', '-A', '-t', '-F', '\t'];
    return {
      kind, image, label: 'PostgreSQL', dialect: 'postgres',
      runArgs: ({ tmpfs }) => [...(tmpfs ? ['--tmpfs', '/var/lib/postgresql/data', '-e', 'PGDATA=/var/lib/postgresql/data/pgdata'] : []), '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', `POSTGRES_DB=${DATABASE}`, image, 'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
      setup: async () => {},
      base,
      readyArgs: (c) => [...base(c), '-c', 'SELECT 1'],
      scriptArgs: (c, { app, stopOnError, wrap }) => [...base(c, { app }), ...(stopOnError ? ['-v', 'ON_ERROR_STOP=1'] : []), ...(wrap ? ['-1'] : []), '-f', '-'],
      scriptInput: (sql) => sql,
      queryArgs: (c) => [...base(c), '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      pollerArgs: (c) => [...base(c, { app: 'msafe-poller' }), '-f', '-'],
      pollInput: () => `${pollSqlPg}\n\\echo @@END\n`,
      errorLines: (stderr) => stderr.split(/\r?\n/).filter((l) => /\bERROR:/.test(l)),
      metaSql: "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum;",
      statsSql: (t, cols) => `SELECT row_to_json(x)::text FROM (SELECT ${pgLiteral(t)} AS t, count(*) AS n${cols.map((c, i) => `, count(${pgQuote(c.name)}) AS c${i}, count(DISTINCT ${pgQuote(c.name)}::text) AS d${i}, coalesce(sum(length(${pgQuote(c.name)}::text)), 0) AS l${i}, min(${pgQuote(c.name)}::text) AS lo${i}, max(${pgQuote(c.name)}::text) AS hi${i}`).join('')} FROM ${pgQuote(t)}) x;`,
      wrapSql: (sql) => sql,
      shell: (c) => `docker exec -it -e PGPASSWORD=${PASSWORD} ${c} psql -h 127.0.0.1 -U postgres ${DATABASE}`,
      lockModes: ['AccessExclusiveLock', 'ExclusiveLock', 'ShareRowExclusiveLock', 'ShareLock'],
    };
  }
  const maria = kind === 'mariadb';
  const eng = {
    kind, image, label: maria ? 'MariaDB' : 'MySQL', dialect: 'mysql', bin: 'mysql',
    runArgs: ({ tmpfs }) => [...(tmpfs ? ['--tmpfs', '/var/lib/mysql'] : []), '-e', `${maria ? 'MARIADB' : 'MYSQL'}_ROOT_PASSWORD=${PASSWORD}`, '-e', `${maria ? 'MARIADB' : 'MYSQL'}_DATABASE=${DATABASE}`, image],
    base: (c, extra = []) => ['exec', '-i', '-e', `MYSQL_PWD=${PASSWORD}`, c, eng.bin, '-h127.0.0.1', '-uroot', '--batch', '--raw', '--skip-column-names', '--default-character-set=utf8mb4', '-D', DATABASE, ...extra],
    readyArgs: (c) => eng.base(c, ['-e', 'SELECT 1']),
    scriptArgs: (c, { stopOnError }) => eng.base(c, stopOnError ? [] : ['--force']),
    scriptInput: (sql) => sql,
    queryArgs: (c) => eng.base(c),
    pollerArgs: (c) => eng.base(c, ['--unbuffered']),
    pollInput: () => `${maria ? pollSqlMaria : pollSqlMysql}\nSELECT '@@END';\n`,
    errorLines: (stderr) => stderr.split(/\r?\n/).filter((l) => /^ERROR \d+/.test(l)),
    metaSql: `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;`,
    statsSql: (t, cols) => `SELECT JSON_OBJECT('t', ${myLiteral(t)}, 'n', COUNT(*)${cols.map((c, i) => {
      const v = GEOMETRY.test(c.type) ? `ST_AsText(${myQuote(c.name)})` : `CAST(${myQuote(c.name)} AS CHAR)`;
      return `, 'c${i}', COUNT(${myQuote(c.name)}), 'd${i}', COUNT(DISTINCT ${myQuote(c.name)}), 'l${i}', COALESCE(SUM(LENGTH(${v})), 0), 'lo${i}', MIN(${v}), 'hi${i}', MAX(${v})`;
    }).join('')}) FROM ${myQuote(t)};`,
    // DDL commits implicitly, so wrapping matters for the DML a migration holds.
    wrapSql: (sql) => {
      const statements = parse(sql, { dialect: 'mysql' }).statements.map((s) => s.text);
      return `START TRANSACTION;\n${statements.join(';\n')}${statements.length ? ';' : ''}\nCOMMIT;\n`;
    },
    shell: (c) => `docker exec -it ${c} ${eng.bin} -h127.0.0.1 -uroot -p${PASSWORD} ${DATABASE}`,
    lockModes: ['EXCLUSIVE', 'SHARED_NO_WRITE', 'SHARED_NO_READ_WRITE', 'SHARED_READ_ONLY'],
    // MariaDB has no metadata lock table in performance_schema: its plugin provides one.
    // Newer MariaDB images ship `mariadb` without the `mysql` name.
    detect: async (c) => {
      if (eng.binFound) return;
      const found = await docker(['exec', c, 'sh', '-c', 'command -v mariadb || command -v mysql']);
      if (found.code === 0 && found.out.trim()) { eng.bin = found.out.trim().split('/').pop(); eng.binFound = true; }
    },
    setup: async (c) => {
      if (maria) await docker(eng.base(c, ['-e', "INSTALL SONAME 'metadata_lock_info'"]));
    },
  };
  return eng;
};

const lockList = (modes) => modes.map((m) => `'${m}'`).join(', ');
const pollSqlPg = `SELECT l.mode || E'\\t' || c.relname FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid JOIN pg_class c ON c.oid = l.relation WHERE l.locktype = 'relation' AND l.granted AND c.relkind IN ('r', 'p') AND a.application_name = '${MIGRATION_APP}' AND l.mode IN (${lockList(['AccessExclusiveLock', 'ExclusiveLock', 'ShareRowExclusiveLock', 'ShareLock'])}) AND c.relnamespace = current_schema()::regnamespace;`;
const pollSqlMysql = `SELECT CONCAT(m.LOCK_TYPE, '\\t', m.OBJECT_NAME) FROM performance_schema.metadata_locks m WHERE m.OBJECT_TYPE = 'TABLE' AND m.OBJECT_SCHEMA = '${DATABASE}' AND m.LOCK_STATUS = 'GRANTED' AND m.LOCK_TYPE IN (${lockList(['EXCLUSIVE', 'SHARED_NO_WRITE', 'SHARED_NO_READ_WRITE', 'SHARED_READ_ONLY'])}) AND m.OWNER_THREAD_ID <> (SELECT t.THREAD_ID FROM performance_schema.threads t WHERE t.PROCESSLIST_ID = CONNECTION_ID());`;
const pollSqlMaria = `SELECT CONCAT(REPLACE(LOCK_MODE, 'MDL_', ''), '\\t', TABLE_NAME) FROM information_schema.METADATA_LOCK_INFO WHERE TABLE_SCHEMA = '${DATABASE}' AND LOCK_MODE IN (${lockList(['MDL_EXCLUSIVE', 'MDL_SHARED_NO_WRITE', 'MDL_SHARED_NO_READ_WRITE', 'MDL_SHARED_READ_ONLY'])}) AND THREAD_ID <> CONNECTION_ID();`;

// ── a second session that polls the lock tables while a migration runs ───────────────────────────────────

const startPoller = (eng, c) => {
  const child = spawn('docker', eng.pollerArgs(c), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const samples = [];
  let rows = [];
  let buf = '';
  let stopped = false;
  let errText = '';
  let firstReply;
  const ready = new Promise((resolve) => { firstReply = resolve; });
  const send = () => { if (!stopped && child.stdin.writable) child.stdin.write(eng.pollInput()); };
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8').on('data', (d) => { errText += d; });
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '@@END') {
        samples.push({ t: performance.now(), rows });
        rows = [];
        firstReply();
        setTimeout(send, POLL_PAUSE_MS);
      } else if (line) rows.push(line.split('\t'));
    }
  });
  child.on('close', () => firstReply());
  send();
  return {
    samples,
    // The first poll answers, or the session failed (no lock table, no privilege).
    started: async () => {
      await Promise.race([ready, new Promise((r) => setTimeout(r, 15000))]);
      return samples.length > 0 ? null : (firstLines(errText, 2) || 'the polling session did not answer');
    },
    stop: () => { stopped = true; child.stdin.end(); setTimeout(() => child.kill(), 500).unref(); },
  };
};

// Locks seen in [t0, t1]: one entry per (mode, table) with how long it was held, to the resolution of the polls.
const locksIn = (samples, t0, t1, tables) => {
  const window = samples.filter((s) => s.t >= t0 && s.t <= t1 + 200);
  const gaps = window.slice(1).map((s, i) => s.t - window[i].t).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : POLL_PAUSE_MS;
  const seen = new Map();
  for (const s of window) {
    for (const [mode, table] of s.rows) {
      if (!tables.has(table)) continue;
      const key = `${mode}\t${table}`;
      const e = seen.get(key) ?? { mode, table, first: s.t, last: s.t, polls: 0 };
      e.last = s.t;
      e.polls++;
      seen.set(key, e);
    }
  }
  return [...seen.values()].map((e) => ({ ...e, ms: e.last - e.first + gap })).sort((a, b) => b.ms - a.ms);
};

// ── what the database holds ──────────────────────────────────────────────────────────────────────

const rows = (text) => text.split(/\r?\n/).filter(Boolean);

const snapshotOf = async (eng, c) => {
  const meta = await run(eng, c, eng.queryArgs(c), eng.metaSql, 'reading the schema');
  const tables = new Map();
  for (const [t, name, type] of rows(meta).map((l) => l.split('\t'))) {
    if (!tables.has(t)) tables.set(t, []);
    tables.get(t).push({ name, type });
  }
  const stats = new Map();
  if (tables.size) {
    const out = await run(eng, c, eng.queryArgs(c), [...tables].map(([t, cols]) => eng.statsSql(t, cols)).join('\n'), 'counting rows');
    for (const line of rows(out)) { try { const o = JSON.parse(line); stats.set(o.t, o); } catch { /* not a result row */ } }
  }
  const snap = new Map();
  for (const [t, cols] of tables) {
    const s = stats.get(t) ?? { n: 0 };
    snap.set(t, {
      rows: Number(s.n),
      columns: new Map(cols.map((col, i) => [col.name, {
        type: col.type, notnull: false, nonNull: Number(s[`c${i}`] ?? 0),
        fingerprint: [s[`d${i}`], s[`l${i}`], s[`lo${i}`], s[`hi${i}`]].join('|'),
      }])),
    });
  }
  return snap;
};

// Runs a client command, returning stdout; a failure is a rehearsal that could not run.
const run = async (eng, c, args, input, what) => {
  const r = await docker(args, { input });
  if (r.code !== 0) throw new RehearsalUsageError(`${what} failed in the container: ${firstLines(r.err || r.out, 3)}`);
  return r.out;
};

const waitReady = async (eng, name, timeoutMs, print) => {
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
    await new Promise((res) => setTimeout(res, 500));
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

// Loads the seed. A `.sql` seed must load without errors; a dump (pg_dump, mysqldump, optionally .gz) loads
// with errors tolerated (ownership and extension statements often fail in a scratch server) and counted.
const loadSeed = async (eng, name, file, dump, print) => {
  const gz = /\.gz$/i.test(file);
  if (dump && eng.kind === 'postgres' && !gz && isPgCustomDump(file)) {
    const r = await docker(['exec', '-i', '-e', `PGPASSWORD=${PASSWORD}`, name, 'pg_restore', '-h', '127.0.0.1', '-U', 'postgres', '-d', DATABASE, '--no-owner', '--no-privileges'], { stream: createReadStream(file), timeoutMs: 3600000 });
    const errors = r.err.split(/\r?\n/).filter((l) => /error/i.test(l));
    if (errors.length) print(`seed: pg_restore reported ${errors.length} error line(s), first: ${errors[0].trim().slice(0, 160)}`);
    return;
  }
  const args = eng.scriptArgs(name, { app: 'msafe-seed', stopOnError: !dump, wrap: false });
  const r = dump
    ? await docker(args, { stream: gz ? createReadStream(file).pipe(createGunzip()) : createReadStream(file), timeoutMs: 3600000 })
    : await docker(args, { input: eng.scriptInput(gz ? '' : decodeSql(readFileSync(file))) });
  if (!dump && r.code !== 0) throw new RehearsalUsageError(`the seed ${file} did not load: ${firstLines(r.err || r.out, 3)}`);
  const errors = eng.errorLines(r.err);
  if (dump && errors.length) print(`seed: the dump loaded with ${errors.length} error line(s), first: ${errors[0].trim().slice(0, 160)}`);
};

// ── the rehearsal ────────────────────────────────────────────────────────────────────────────────

// opts: { engine, source, dump (boolean), ups, downs, runner, allowLoss, lockBudgetMs, keep, startupTimeoutMs }
export const rehearseDocker = async (opts, print) => {
  const spec = parseEngine(opts.engine);
  const { source, ups, downs = null } = opts;
  if (!source || !ups.length) throw new RehearsalUsageError('a seed (or --dump file) and at least one migration are needed');
  if (opts.runner && !RUNNER_IDS.includes(opts.runner)) throw new RehearsalUsageError(`unknown runner ${opts.runner}`);
  for (const f of [source, ...ups, ...(Array.isArray(downs) ? downs : [])]) if (!existsSync(f)) throw new RehearsalUsageError(`${f} does not exist`);
  const eng = makeEngine(spec);
  const downFiles = downs === 'sections' ? ups : downs;
  if (downs === 'sections') for (const f of ups) if (!partFor(f, 'down', eng.dialect).hasDown) throw new RehearsalUsageError(`${f} has no down section: pass the down files after --down`);
  const detected = opts.runner ? { id: opts.runner, evidence: '--runner' } : detectRunner(ups[0], { markers: partFor(ups[0], 'up', eng.dialect).markers, fileName: ups[0].split(/[\\/]/).at(-1) });
  const profile = profileOf(detected.id);
  const allowLoss = new Set(opts.allowLoss ?? []);
  const budget = opts.lockBudgetMs ?? DEFAULT_LOCK_BUDGET_MS;

  await ensureDocker();
  await ensureImage(spec.image, print);

  const name = `msafe-rehearse-${process.pid}-${randomBytes(3).toString('hex')}`;
  hookExit();
  live.add(name);
  let poller = null;
  let finished = false;
  try {
    // Data lives in memory (much faster to initialise and load) unless the seed is too big for that or --disk is given.
    const tmpfs = opts.disk !== true && statSync(source).size <= TMPFS_SEED_LIMIT;
    const started = await docker(['run', '-d', '--name', name, '--label', 'msafe-rehearse=1', ...eng.runArgs({ tmpfs })], { timeoutMs: 120000 });
    if (started.code !== 0) throw new RehearsalUsageError(`could not start ${spec.image}: ${firstLines(started.err, 2)}`);
    print(`runner: ${profile.label} (${detected.evidence}) · engine ${spec.image} in container ${name}`);
    await waitReady(eng, name, opts.startupTimeoutMs ?? 240000);
    await eng.setup(name);
    const t0 = performance.now();
    await loadSeed(eng, name, source, opts.dump === true, print);
    let current = await snapshotOf(eng, name);
    const seeded = [...current.values()].reduce((n, t) => n + t.rows, 0);
    print(`seed: ${source} loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s (${current.size} table(s), ${seeded} row(s))`);
    const start = current;

    // the cost of one docker exec round trip, taken off the durations
    const trips = [];
    for (let i = 0; i < 3; i++) { const a = performance.now(); await docker(eng.readyArgs(name)); trips.push(performance.now() - a); }
    const overhead = trips.sort((a, b) => a - b)[0];

    poller = startPoller(eng, name);
    const pollError = await poller.started();
    if (pollError) print(`locks: not measured (${pollError.slice(0, 160)})`);

    let failed = 0;
    const apply = async (file, kind) => {
      const part = partFor(file, kind, eng.dialect);
      const wrap = wrapsFile(profile, { noTransaction: part.markers.noTransaction, statements: part.statements });
      const sql = wrap ? eng.wrapSql(part.sql) : part.sql;
      const before = current;
      const a = performance.now();
      const r = await docker(eng.scriptArgs(name, { app: MIGRATION_APP, stopOnError: true, wrap }), { input: eng.scriptInput(sql), timeoutMs: 3600000 });
      const b = performance.now();
      if (r.code !== 0) {
        failed++;
        print(`FAILED  ${kind.padEnd(4)} ${file}: ${firstLines(r.err || r.out, 3)}`);
        if (eng.dialect === 'mysql' && !wrap) print('          statements before the failing one stay applied: MySQL DDL commits implicitly');
        return false;
      }
      const ms = Math.max(0, b - a - overhead);
      current = await snapshotOf(eng, name);
      const { lines, lost } = diff(before, current, kind, allowLoss);
      const held = pollError ? [] : locksIn(poller.samples, a, b, new Set(before.keys()));
      const over = held.filter((l) => l.ms > budget);
      const bad = lost.length || over.length;
      if (bad) failed++;
      print(`${lost.length ? 'LOST   ' : over.length ? 'LOCKED ' : 'ran    '} ${kind.padEnd(4)} ${file} in ${ms.toFixed(0)} ms`);
      lines.forEach((l) => print(`          ${l}`));
      lost.forEach((l) => print(`          lost: ${l}`));
      held.forEach((l) => print(`          lock: ${l.mode} on ${l.table} held ~${(l.ms / 1000).toFixed(2)} s (${l.polls} poll(s))${l.ms > budget ? `, over the ${(budget / 1000).toFixed(2).replace(/\.?0+$/, '')} s budget` : ''}`));
      if (!held.length && !pollError) print(`          lock: no write-blocking lock seen on existing tables (polled every ~${POLL_PAUSE_MS} ms)`);
      return true;
    };

    let stopped = null;
    for (const f of ups) if (!await apply(f, 'up')) { stopped = f; break; }
    if (stopped) {
      ups.slice(ups.indexOf(stopped) + 1).forEach((f) => print(`SKIPPED up   ${f}: an earlier migration failed`));
    } else if (downFiles) {
      for (const f of [...downFiles].reverse()) if (!await apply(f, 'down')) { stopped = f; break; }
      if (!stopped) {
        const restored = diff(start, current, 'down', allowLoss).lines
          .filter((l) => / new, |dropped|columns:/.test(l));
        print(restored.length ? `after the down(s) the schema differs from the seed: ${restored[0].replace(/\s+/g, ' ')}` : 'after the down(s) the tables and columns match the seed');
        for (const f of ups) if (!await apply(f, 'up')) { stopped = f; break; }
      }
    }
    const nDown = downFiles ? downFiles.length : 0;
    print(`${ups.length} up(s)${nDown ? `, ${nDown} down(s)` : ''} on ${spec.image} seeded from ${source}: ${failed ? `${failed} problem(s)${stopped ? `, stopped at ${stopped}` : ''}` : `all ran, no rows or values lost, no write lock over ${(budget / 1000).toFixed(2).replace(/\.?0+$/, '')} s`}`);
    finished = true;
    return failed ? 1 : 0;
  } finally {
    poller?.stop();
    if (opts.keep && finished) {
      live.delete(name);
      print(`container ${name} kept for inspection (password ${PASSWORD}).\n  connect: ${eng.shell(name)}\n  remove:  docker rm -f -v ${name}`);
    } else {
      await docker(['rm', '-f', '-v', name], { timeoutMs: 120000 }).catch(() => {});
      live.delete(name);
      if (opts.keep) print(`the run did not finish, so container ${name} was removed`);
    }
  }
};
