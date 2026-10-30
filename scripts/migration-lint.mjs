#!/usr/bin/env node
// migration-lint.mjs <file|dir>... [options]
//
// Static linter for SQL migration files (PostgreSQL, SQLite, MySQL). It reads each file's "up" part
// statement by statement and reports what can lose data, break the running code, lock a big table or
// leave no way back. With --history it also checks the git history: migrations that already exist on
// the base branch and were edited, renamed or deleted; new ones that sort before the base's last one;
// two migrations with the same sequence. Exit 0 no errors, 1 errors (or warnings with --strict),
// 2 could not run — a 2 is never a pass.
//
//   --dialect postgres|sqlite|mysql   default postgres; a file can say `-- migration-lint: dialect sqlite`
//   --history                         also run the git checks; with no paths, lint the migrations new in the branch
//   --repo <dir>                      repository for --history (default: the cwd)
//   --base <ref>                      base for --history (default: merge-base of HEAD and origin/main, main, master)
//   --strict                          warnings fail too
//   --json                            print the findings as JSON
//
// Silencing a finding is a recorded decision, written next to the statement (or anywhere for the file):
//   -- migration-lint: allow drop-column -- approved by <who> on <date>, backup <id>
//   -- migration-lint: allow-file not-atomic -- the runner wraps each file in a transaction
//   -- migration-lint: irreversible -- restore from the nightly snapshot (PITR) if needed
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ERROR = 'error';
const WARN = 'warning';

// ── Reading SQL ──────────────────────────────────────────────────────────────────────────────────

const DOWN_MARKER = /^\s*--\s*(\+goose\s+down|\+migrate\s+down|migrate:down)\b/i;
const DIRECTIVE = /migration-lint:\s*(allow-file|allow|irreversible|dialect)\b\s*([^\n]*)/i;

// Statements of the up part, with their first line, and the directives found in comments.
export const parse = (sql) => {
  const statements = [];
  const directives = [];
  let hasDownSection = false;
  let buf = '';
  let start = null;
  let line = 1;
  let i = 0;
  let lastEnd = 0;
  const push = () => {
    if (buf.trim()) { statements.push({ text: buf.trim(), line: start }); lastEnd = line; }
    buf = '';
    start = null;
  };
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const comment = sql.slice(i, end === -1 ? sql.length : end);
      if (DOWN_MARKER.test(comment)) { hasDownSection = true; push(); break; }
      const d = comment.match(DIRECTIVE);
      // Inside a statement, or on its own line before one: that statement. Trailing `stmt; -- …`: the one it ends.
      if (d) directives.push({ kind: d[1].toLowerCase(), arg: d[2].trim(), line, statement: !buf.trim() && lastEnd === line ? statements.length - 1 : statements.length });
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const body = sql.slice(i, end === -1 ? sql.length : end + 2);
      line += (body.match(/\n/g) || []).length;
      buf += ' ';
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
      const lit = sql.slice(i, j + 1);
      if (start === null) start = line;
      line += (lit.match(/\n/g) || []).length;
      buf += lit;
      i = j + 1;
      continue;
    }
    const dollar = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const lit = sql.slice(i, end === -1 ? sql.length : end + tag.length);
      if (start === null) start = line;
      line += (lit.match(/\n/g) || []).length;
      buf += lit;
      i += lit.length;
      continue;
    }
    if (ch === ';') { push(); i++; continue; }
    if (ch === '\n') line++;
    if (start === null && /\S/.test(ch)) start = line;
    buf += ch;
    i++;
  }
  push();
  return { statements, directives, hasDownSection };
};

const ident = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)(?:\.(?:"[^"]+"|\`[^\`]+\`|[\w$]+))?`;
const name = (raw) => (raw ?? '').replace(/["`[\]]/g, '').replace(/^.*\./, '').toLowerCase();
const flat = (s) => s.replace(/\s+/g, ' ');

// ── Rules over one file ──────────────────────────────────────────────────────────────────────────

const VOLATILE = /\b(now|current_timestamp|clock_timestamp|statement_timestamp|random|gen_random_uuid|uuid_generate_v[14]|uuid|newid|sysdate|transaction_timestamp)\b\s*(\(|\b)/i;
const LOCKING_ALTER = /^alter table\b/i;

export const lintFile = (sql, opts = {}) => {
  const { statements, directives, hasDownSection } = parse(sql);
  const fileDialect = directives.find((d) => d.kind === 'dialect')?.arg.split(/\s/)[0]?.toLowerCase();
  const dialect = fileDialect || opts.dialect || 'postgres';
  const pg = dialect === 'postgres';
  const findings = [];
  const created = new Set();
  const texts = statements.map((s) => flat(s.text));
  const all = texts.join(';\n');
  const inTransaction = /^(begin|start transaction)\b/im.test(all);
  const hasLockTimeout = /\bset\s+(local\s+)?lock_timeout\b/i.test(all);
  const allowedFile = new Set(directives.filter((d) => d.kind === 'allow-file').flatMap((d) => d.arg.split(/\s+--|\s#/)[0].split(/[\s,]+/).filter(Boolean)));
  const allowedAt = (k, rule) => directives.some((d) => d.kind === 'allow' && d.statement === k && d.arg.split(/\s+--|\s#/)[0].split(/[\s,]+/).includes(rule));

  // SQLite (and Prisma/Drizzle on SQLite) change a table by rebuilding it: create new_t, copy, drop t, rename new_t to t.
  const copiedFrom = new Map();
  for (const t of texts) {
    const m = t.match(new RegExp(String.raw`^insert into (${ident})[^;]*?\bselect\b[^;]*?\bfrom (${ident})`, 'i'));
    if (m) copiedFrom.set(name(m[2]), name(m[1]));
  }
  const renamedTo = new Map();
  for (const t of texts) {
    const m = t.match(new RegExp(String.raw`^alter table (${ident}) rename to (${ident})`, 'i'));
    if (m) renamedTo.set(name(m[1]), name(m[2]));
  }
  const rebuilt = (table) => copiedFrom.has(table) && renamedTo.get(copiedFrom.get(table)) === table;

  const add = (k, level, rule, message) => {
    if (allowedFile.has(rule) || allowedAt(k, rule)) return;
    findings.push({ level, rule, line: statements[k].line, message });
  };

  texts.forEach((t, k) => {
    const create = t.match(new RegExp(String.raw`^create (?:temp(?:orary)? |unlogged )?table (?:if not exists )?(${ident})`, 'i'));
    if (create) { created.add(name(create[1])); return; }
    const altered = t.match(new RegExp(String.raw`^alter table (?:if exists )?(?:only )?(${ident})`, 'i'));
    const table = altered ? name(altered[1]) : null;
    const existing = table !== null && !created.has(table);

    // Destructive
    const drop = t.match(new RegExp(String.raw`^drop table (?:if exists )?(${ident})`, 'i'));
    if (drop && !created.has(name(drop[1])) && !rebuilt(name(drop[1])))
      add(k, ERROR, 'drop-table', `drops table ${name(drop[1])} and its data: only in a contract step, after the code stopped using it, with a verified backup and a recorded approval`);
    if (/^truncate\b/i.test(t)) add(k, ERROR, 'truncate', 'deletes every row: needs a verified backup and a recorded approval');
    if (/^delete from\b/i.test(t) && !/\bwhere\b/i.test(t)) add(k, ERROR, 'delete-all', 'DELETE with no WHERE removes every row');
    if (/^update\b/i.test(t) && !/\bwhere\b/i.test(t) && !created.has(name(t.match(new RegExp(String.raw`^update (?:only )?(${ident})`, 'i'))?.[1])))
      add(k, ERROR, 'update-all', 'UPDATE with no WHERE rewrites the whole table in one transaction: backfill in batches by key range, outside the DDL migration, idempotent');
    if (altered && /\bdrop (?:column )?(?:if exists )?(?!(?:constraint|index|key|default|not null|primary|foreign|check|partition|expression|identity)\b)[\w"`]+/i.test(t.replace(/^alter table \S+/i, '')))
      add(k, ERROR, 'drop-column', `drops a column of ${table}: the running code still selects or inserts it — contract step only, after a release that stopped using it, with a backup and a recorded approval`);

    // Breaks the running code
    if (altered && /\brename column\b|\brename (?!to\b)[\w"`]+ to\b/i.test(t) && !/\brename constraint\b/i.test(t))
      add(k, ERROR, 'rename-column', `renames a column of ${table} in one step: the code in production still uses the old name — expand (add new, write both, backfill), switch reads, contract later`);
    if (altered && existing && /\brename to\b/i.test(t) && !rebuilt(renamedTo.get(table)))
      add(k, ERROR, 'rename-table', `renames table ${table} in one step: create the new one (or a view with the old name) and move readers first`);
    if (altered && (/\balter (?:column )?[\w"`]+ (?:set data )?type\b/i.test(t) || (dialect === 'mysql' && /\b(modify|change) (?:column )?\w/i.test(t))))
      add(k, ERROR, 'change-column-type', `changes a column type of ${table}: can rewrite the table under an exclusive lock and break readers — new column, backfill, switch, drop later (widening varchar(n) or varchar→text is the safe exception: allow it with a reason)`);
    const addCol = altered && t.match(/\badd (?:column )?(?!constraint|index|key|unique|primary|foreign|check)(?:if not exists )?[\w"`]+ [^,]*?(?=,\s*add\b|$)/gi);
    for (const def of addCol || []) {
      if (/\bnot null\b/i.test(def) && !/\bdefault\b/i.test(def) && !/\b(generated|identity|serial|bigserial)\b/i.test(def) && existing)
        add(k, ERROR, 'not-null-without-default', `adds a NOT NULL column with no DEFAULT to ${table}: fails on a populated table, and old code that inserts without it breaks — add it nullable (or with a constant default), backfill, then enforce`);
      if (pg && /\bdefault\b/i.test(def) && VOLATILE.test(def.split(/\bdefault\b/i)[1]) && existing)
        add(k, WARN, 'volatile-default', `adds a column to ${table} with a volatile default: rewrites the whole table under ACCESS EXCLUSIVE — add without default, set the default apart, backfill in batches`);
      if (pg && existing && /\b(serial|bigserial|generated always as \(.*\) stored|generated (always|by default) as identity)\b/i.test(def))
        add(k, WARN, 'rewriting-column', `adds a serial, identity or stored generated column to ${table}: rewrites the table under ACCESS EXCLUSIVE`);
    }

    // Long locks (PostgreSQL)
    if (pg && altered && existing && /\balter (?:column )?[\w"`]+ set not null\b/i.test(t))
      add(k, WARN, 'set-not-null', `SET NOT NULL scans ${table} under ACCESS EXCLUSIVE: first ADD CONSTRAINT … CHECK (col IS NOT NULL) NOT VALID, VALIDATE it in a later migration, then SET NOT NULL (PG 12+ skips the scan)`);
    if (pg && altered && existing && /\badd (?:constraint [\w"`]+ )?(foreign key|check)\b/i.test(t) && !/\bnot valid\b/i.test(t))
      add(k, WARN, 'constraint-without-not-valid', `adds a ${/foreign/i.test(t) ? 'FOREIGN KEY' : 'CHECK'} to ${table} validating every row under lock: add it NOT VALID, then VALIDATE CONSTRAINT in a separate migration`);
    if (pg && altered && existing && /\badd (?:constraint [\w"`]+ )?(unique|primary key)\b/i.test(t) && !/\busing index\b/i.test(t))
      add(k, WARN, 'constraint-builds-index', `adds a UNIQUE/PRIMARY KEY to ${table}, building its index under ACCESS EXCLUSIVE: CREATE UNIQUE INDEX CONCURRENTLY, then ADD CONSTRAINT … USING INDEX (and existing duplicates make it fail — check first)`);
    const index = t.match(new RegExp(String.raw`^create (unique )?index (concurrently )?(?:if not exists )?(?:${ident} )?on (?:only )?(${ident})`, 'i'));
    if (pg && index && !index[2] && !created.has(name(index[3])))
      add(k, WARN, 'index-without-concurrently', `builds an index on ${name(index[3])} blocking writes for the whole build: CREATE INDEX CONCURRENTLY, outside a transaction${index[1] ? ' (unique: existing duplicates make it fail — check first)' : ''}`);
    if (pg && /^drop index\b/i.test(t) && !/\bconcurrently\b/i.test(t))
      add(k, WARN, 'drop-index-without-concurrently', 'DROP INDEX takes ACCESS EXCLUSIVE on its table: DROP INDEX CONCURRENTLY');
    if (pg && /\bconcurrently\b/i.test(t) && inTransaction)
      add(k, ERROR, 'concurrently-in-transaction', 'CONCURRENTLY cannot run inside a transaction: put it in its own migration with the runner\'s no-transaction mode');
    if (dialect === 'mysql' && altered && !/\balgorithm\s*=/i.test(t))
      add(k, WARN, 'mysql-no-algorithm', `ALTER TABLE ${table} without ALGORITHM/LOCK may copy the table under lock: declare ALGORITHM=INSTANT|INPLACE, LOCK=NONE so it fails instead; for a COPY on a big table use gh-ost`);
  });

  const locking = texts.some((t) => {
    const m = t.match(new RegExp(String.raw`^alter table (?:if exists )?(?:only )?(${ident})`, 'i'));
    return m && !created.has(name(m[1]));
  });
  if (pg && locking && !hasLockTimeout && !allowedFile.has('missing-lock-timeout'))
    findings.push({ level: WARN, rule: 'missing-lock-timeout', line: statements[0]?.line ?? 1, message: "ALTER TABLE on an existing table without SET lock_timeout: a long query ahead of it makes every read and write queue behind its lock — SET lock_timeout = '5s' and retry on failure" });

  const ddl = texts.filter((t) => !/^(begin|start transaction|commit|set\b|pragma\b)/i.test(t));
  const concurrent = texts.some((t) => /\bconcurrently\b/i.test(t));
  if (dialect !== 'mysql' && ddl.length > 1 && !inTransaction && !concurrent && !allowedFile.has('not-atomic'))
    findings.push({ level: WARN, rule: 'not-atomic', line: statements[0]?.line ?? 1, message: `${ddl.length} statements outside a transaction: a failure halfway leaves the schema between versions — BEGIN/COMMIT, or allow-file it when the runner wraps each file` });

  return { findings, hasDownSection, irreversible: directives.some((d) => d.kind === 'irreversible' && d.arg.replace(/^--\s*/, '').length > 3), statements: statements.length, dialect };
};

// ── Files ────────────────────────────────────────────────────────────────────────────────────────

const isDownFile = (f) => /(^|[._-])down\.sql$/i.test(basename(f)) || /^U\d/.test(basename(f));

// A down that sits next to the file: x.down.sql, folder/down.sql, Flyway's U<n>__x.sql.
const hasDownSibling = (file) => {
  const b = basename(file);
  const dir = dirname(file);
  const candidates = [];
  if (/\.up\.sql$/i.test(b)) candidates.push(join(dir, b.replace(/\.up\.sql$/i, '.down.sql')));
  if (/^up\.sql$/i.test(b)) candidates.push(join(dir, 'down.sql'));
  if (/^V\d/.test(b)) candidates.push(join(dir, b.replace(/^V/, 'U')));
  return candidates.some(existsSync);
};

const sqlFiles = (path) => {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path).flatMap((n) => sqlFiles(join(path, n))).filter((f) => /\.sql$/i.test(f));
};

// ── History (git) ────────────────────────────────────────────────────────────────────────────────

const MIGRATION_DIR = /(^|\/)(migrations?|db\/migrate|alembic\/versions|db\/changelogs?|db\/changesets?)\//i;
const git = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`git could not run (${r.error.code})`);
  return r;
};
const baseOf = (repo, ref) => {
  if (git(repo, ['rev-parse', '--git-dir']).status !== 0) throw new Error(`${repo} is not a git repository`);
  if (ref) {
    const r = git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    if (r.status !== 0) throw new Error(`base ${ref} not found`);
    return { sha: r.stdout.trim(), label: ref };
  }
  for (const cand of ['origin/main', 'main', 'master']) {
    const r = git(repo, ['merge-base', 'HEAD', cand]);
    if (r.status === 0 && r.stdout.trim()) return { sha: r.stdout.trim(), label: `merge-base of HEAD and ${cand}` };
  }
  throw new Error('no base: pass --base <ref>');
};
const seqOf = (n) => {
  const m = n.match(/^([VU]?)(\d+(?:[._]\d+)*)(?=__|_|-|\.|$)/);
  return m ? { parts: m[2].split(/[._]/).map(BigInt), key: m[2].replace(/_/g, '.') } : null;
};
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0n) - (b[i] ?? 0n); if (d) return d < 0n ? -1 : 1; }
  return 0;
};
const unitOf = (f) => {
  const parts = f.split('/');
  const leaf = parts.at(-1);
  if (/^(migration|up|down)\.\w+$/i.test(leaf) && parts.length > 2) return { group: parts.slice(0, -2).join('/'), name: parts.at(-2) };
  return { group: parts.slice(0, -1).join('/'), name: leaf.replace(/(\.(up|down))*\.\w+$/i, '').replace(/^U(?=\d)/, 'V') };
};

export const historyFindings = (repo, ref) => {
  const base = baseOf(repo, ref);
  const out = [];
  const changed = git(repo, ['diff', '--name-status', '-M', '--diff-filter=MDRT', base.sha]).stdout.split('\n').filter(Boolean);
  for (const l of changed) {
    const [status, file, to] = l.split('\t');
    if (!MIGRATION_DIR.test(file)) continue;
    const verb = { M: 'edits', D: 'deletes', R: 'renames', T: 'changes the type of' }[status[0]] ?? 'changes';
    out.push({ level: ERROR, rule: 'applied-migration-changed', file, line: 1, message: `the branch ${verb} ${file}${to ? ` (to ${to})` : ''}, which exists in ${base.label} and is assumed applied everywhere: restore it and write the correction as a new migration` });
  }
  const inBase = git(repo, ['ls-tree', '-r', '--name-only', '-z', base.sha]).stdout.split('\0').filter((f) => MIGRATION_DIR.test(f));
  const baseSet = new Set(inBase);
  const present = git(repo, ['ls-files', '-co', '--exclude-standard', '-z']).stdout.split('\0').filter((f) => f && MIGRATION_DIR.test(f) && existsSync(join(repo, f)));
  const fresh = present.filter((f) => !baseSet.has(f));
  const groups = new Map();
  const put = (f, isFresh) => {
    const u = unitOf(f);
    if (!groups.has(u.group)) groups.set(u.group, new Map());
    const g = groups.get(u.group);
    if (!g.has(u.name)) g.set(u.name, { ...u, file: f, fresh: false, seq: seqOf(u.name) });
    if (isFresh) g.get(u.name).fresh = true;
  };
  inBase.forEach((f) => put(f, false));
  fresh.forEach((f) => put(f, true));
  for (const [group, units] of groups) {
    const settled = [...units.values()].filter((u) => !u.fresh && u.seq);
    const last = settled.reduce((a, u) => (!a || cmp(u.seq.parts, a.seq.parts) > 0 ? u : a), null);
    for (const u of [...units.values()].filter((x) => x.fresh && x.seq))
      if (last && cmp(u.seq.parts, last.seq.parts) < 0)
        out.push({ level: ERROR, rule: 'out-of-order', file: u.file, line: 1, message: `${u.name} sorts before ${last.name}, the last migration of ${base.label}: runners skip or reject it on environments already past it — renumber it on top` });
    const bySeq = new Map();
    for (const u of [...units.values()].filter((x) => x.seq)) bySeq.set(u.seq.key, [...(bySeq.get(u.seq.key) ?? []), u]);
    for (const [key, same] of bySeq)
      if (same.length > 1 && same.some((u) => u.fresh))
        out.push({ level: ERROR, rule: 'duplicate-sequence', file: same.find((u) => u.fresh).file, line: 1, message: `sequence ${key} is used by ${same.map((u) => u.name).join(' and ')} in ${group || '.'}: renumber the branch's one` });
  }
  return { findings: out, fresh, base };
};

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const main = (argv) => {
  const paths = [];
  const opt = { dialect: 'postgres', strict: false, json: false, history: false, repo: '.', base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dialect') opt.dialect = argv[++i];
    else if (a === '--strict') opt.strict = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--base') opt.base = argv[++i];
    else if (a === '--history') opt.history = true;
    else if (a === '--repo') opt.repo = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else paths.push(a);
  }
  if (!['postgres', 'sqlite', 'mysql'].includes(opt.dialect)) throw new Error(`unknown dialect ${opt.dialect}`);
  if (!paths.length && !opt.history) throw new Error('usage: migration-lint.mjs <file|dir>... [--dialect postgres|sqlite|mysql] [--history [--repo dir]] [--base ref] [--strict] [--json]');
  const findings = [];
  let history = null;
  if (opt.history) {
    const repo = resolve(opt.repo);
    history = historyFindings(repo, opt.base);
    findings.push(...history.findings);
    if (!paths.length) paths.push(...history.fresh.filter((f) => /\.sql$/i.test(f)).map((f) => join(repo, f)));
  }
  const files = paths.flatMap((p) => { if (!existsSync(p)) throw new Error(`${p} does not exist`); return sqlFiles(p); }).filter((f) => !isDownFile(f));
  for (const file of files) {
    const r = lintFile(readFileSync(file, 'utf8'), opt);
    const rel = relative(process.cwd(), file).replaceAll('\\', '/') || file;
    findings.push(...r.findings.map((f) => ({ ...f, file: rel })));
    if (!r.hasDownSection && !hasDownSibling(file) && !r.irreversible)
      findings.push({ level: WARN, rule: 'missing-down', file: rel, line: 1, message: 'no way back: add a down (x.down.sql, down.sql, a Down section) that runs, or declare `-- migration-lint: irreversible -- <recovery plan>`' });
  }
  const errors = findings.filter((f) => f.level === ERROR).length;
  const warnings = findings.length - errors;
  if (opt.json) console.log(JSON.stringify({ files: files.length, errors, warnings, findings }, null, 2));
  else {
    for (const f of findings) console.log(`${f.level.padEnd(7)} ${f.rule.padEnd(28)} ${f.file}:${f.line}  ${f.message}`);
    console.log(`${files.length} file(s)${history ? `, history vs ${history.base.label}` : ''}: ${errors} error(s), ${warnings} warning(s)`);
  }
  return errors || (opt.strict && warnings) ? 1 : 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`could not run: ${e.message}`); process.exitCode = 2; }
}
