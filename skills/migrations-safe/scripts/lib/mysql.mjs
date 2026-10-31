// MySQL and MariaDB knowledge the rules need: server versions, which online DDL algorithm an operation can
// use, ENUM/SET definitions, and where the server version of a project is declared.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UsageError } from './errors.mjs';
import { ident, name, splitTopLevel } from './parse.mjs';

export const DEFAULT_MYSQL_VERSION = '8.0';
// A table can hold 64 row versions created by instant ADD/DROP COLUMN; a rebuild resets the count.
export const INSTANT_ROW_VERSION_LIMIT = 64;
export const INSTANT_ROW_VERSION_WARN = 56;

// "8.0", "8.0.28", "5.7", "mariadb-10.6", "mariadb:10.11.4". A missing patch means the newest patch of the series.
export const parseMysqlVersion = (text) => {
  const m = String(text ?? '').trim().toLowerCase().match(/^(?:(mysql|mariadb)[-:\s]?)?v?(\d+)\.(\d+)(?:\.(\d+))?(?![\d.])/);
  if (!m) return null;
  const flavor = m[1] ?? 'mysql';
  const [major, minor] = [Number(m[2]), Number(m[3])];
  const patch = m[4] === undefined ? null : Number(m[4]);
  return { flavor, major, minor, patch, label: `${flavor === 'mariadb' ? 'MariaDB' : 'MySQL'} ${major}.${minor}${patch === null ? '' : `.${patch}`}` };
};

export const mysqlVersionOrThrow = (text) => {
  const v = parseMysqlVersion(text);
  if (!v) throw new UsageError(`unknown MySQL version "${String(text).slice(0, 30)}" (examples: 8.0, 8.0.28, 8.4, 5.7, mariadb-10.6)`);
  return v;
};

// True when the server is `major.minor.patch` or newer (an unknown patch counts as the newest of its series).
export const atLeast = (v, major, minor, patch = 0) => {
  if (v.major !== major) return v.major > major;
  if (v.minor !== minor) return v.minor > minor;
  return (v.patch ?? Infinity) >= patch;
};

export const isMaria = (v) => v.flavor === 'mariadb';

// Whether ALGORITHM=INSTANT exists at all.
export const supportsInstant = (v) => (isMaria(v) ? atLeast(v, 10, 3) : atLeast(v, 8, 0, 12));
export const instantDrop = (v) => (isMaria(v) ? atLeast(v, 10, 4) : atLeast(v, 8, 0, 29));
export const instantAnyPosition = (v) => (isMaria(v) ? atLeast(v, 10, 4) : atLeast(v, 8, 0, 29));
export const instantRenameColumn = (v) => !isMaria(v) && atLeast(v, 8, 0, 28);
export const hasRenameColumn = (v) => (isMaria(v) ? atLeast(v, 10, 5, 2) : atLeast(v, 8, 0));
export const instantIsDefault = (v) => !isMaria(v) && atLeast(v, 8, 0, 12);

const POSITION = /\b(?:first|after\s+\S+)\s*$/i;
export const hasPosition = (action) => POSITION.test(action);

// Why `action` cannot run with ALGORITHM=INSTANT (or INPLACE) on this server, or null.
export const algorithmProblem = (action, algorithm, version, { addsPrimaryKey, fkChecksOff }) => {
  const a = action.trim();
  const column = a.match(/^add (?:column )?(?!constraint\b|index\b|key\b|unique\b|primary\b|foreign\b|check\b|fulltext\b|spatial\b)/i);
  const addIndex = /^add (?:unique |fulltext |spatial )?(?:index|key)\b|^add (?:constraint \S+ )?unique\b|^add (?:fulltext|spatial)\b/i.test(a);
  if (algorithm === 'instant') {
    if (column && hasPosition(a) && !instantAnyPosition(version))
      return `adding a column at FIRST/AFTER is not instant before ${isMaria(version) ? 'MariaDB 10.4' : 'MySQL 8.0.29'} (only as the last column)`;
    if (/^drop column\b/i.test(a) && !instantDrop(version)) return `dropping a column is not instant before ${isMaria(version) ? 'MariaDB 10.4' : 'MySQL 8.0.29'}`;
    if (/^rename column\b/i.test(a) && !instantRenameColumn(version) && !isMaria(version)) return 'renaming a column is not instant before MySQL 8.0.28 (INPLACE only)';
    if (addIndex || /^(?:add|drop) primary key\b/i.test(a) || /^drop (?:index|key)\b/i.test(a)) return 'index and primary key changes are INPLACE, never INSTANT';
    if (/^add (?:constraint \S+ )?foreign key\b/i.test(a)) return 'adding a foreign key is never INSTANT';
    if (/^(?:modify|change) (?:column )?\S+/i.test(a) && !/\b(?:enum|set)\s*\(/i.test(a) && !/^change (?:column )?(\S+) (\S+)/i.test(a)) return 'changing a column definition is not INSTANT';
    if (/^(?:convert to|force$|engine\s*=)/i.test(a) || /^(?:row_format|key_block_size)\b/i.test(a)) return 'a table rebuild is never INSTANT';
  }
  if (algorithm === 'inplace' || algorithm === 'nocopy') {
    if (/^drop primary key\b/i.test(a) && !addsPrimaryKey) return 'dropping a primary key without adding one in the same statement only works with ALGORITHM=COPY';
    if (/^add (?:constraint \S+ )?foreign key\b/i.test(a) && !fkChecksOff) return 'adding a foreign key with foreign_key_checks=1 only works with ALGORITHM=COPY';
    if (/^convert to\b/i.test(a)) return 'converting the character set copies the table';
  }
  return null;
};

// ── ENUM and SET ───────────────────────────────────────────────────────────────────────────────────

const ENUM_DEF = /^(?:(?:modify|add)\s+(?:column\s+)?(?:if not exists\s+)?(\S+)|change\s+(?:column\s+)?\S+\s+(\S+)|(\S+))\s+(enum|set)\s*\(((?:\s*'(?:[^'\\]|\\.|'')*'\s*,?)+)\s*\)/i;

// { column, kind, members } when `text` (an ALTER action or a CREATE TABLE element) defines an ENUM or SET column.
export const enumOf = (text) => {
  const m = text.trim().match(ENUM_DEF);
  if (!m) return null;
  const members = [...m[5].matchAll(/'((?:[^'\\]|\\.|'')*)'/g)].map((x) => x[1]);
  return { column: name(m[1] ?? m[2] ?? m[3]), kind: m[4].toLowerCase(), members };
};

export const storageBytes = (e) => {
  if (e.kind === 'enum') return e.members.length <= 255 ? 1 : 2;
  const n = e.members.length;
  return n <= 8 ? 1 : n <= 16 ? 2 : n <= 24 ? 3 : n <= 32 ? 4 : 8;
};

// 'append' (instant), 'resize' (appended but the storage grows: copy), 'reorder' (members renumbered, removed or kind changed: copy), 'same'.
export const enumChange = (before, after) => {
  if (before.kind !== after.kind) return 'reorder';
  const prefix = before.members.length <= after.members.length && before.members.every((m, i) => m === after.members[i]);
  if (!prefix) return 'reorder';
  if (after.members.length === before.members.length) return 'same';
  return storageBytes(before) === storageBytes(after) ? 'append' : 'resize';
};

const CREATE_BODY = new RegExp(String.raw`^create (?:temp(?:orary)? )?table (?:if not exists )?(${ident})\s*\((.*)\)[^)]*$`, 'is');

// The ENUM/SET columns and the leading columns of every index a CREATE TABLE declares.
export const createFacts = (text) => {
  const m = text.match(CREATE_BODY);
  if (!m) return null;
  const enums = new Map();
  const indexed = new Set();
  for (const el of splitTopLevel(m[2])) {
    if (!/^(?:constraint|primary|foreign|unique|check|key|index|fulltext|spatial)\b/i.test(el)) {
      const e = enumOf(el);
      if (e) enums.set(e.column, e);
      if (/\b(?:primary key|unique(?: key)?)\b/i.test(el.replace(/'(?:[^'\\]|\\.|'')*'/g, "''"))) indexed.add(name(el.match(new RegExp(`^(${ident})`))?.[1]));
    } else {
      const c = indexedColumn(el);
      if (c) indexed.add(c);
    }
  }
  return { table: name(m[1]), enums, indexed };
};

// Leading column of an index (or key, unique, primary key, foreign key) definition, or null.
export const indexedColumn = (def) => {
  const m = def.trim().match(/^(?:add\s+)?(?:constraint\s+(?:\S+\s+)?)?(?:primary key|unique(?:\s+(?:key|index))?|fulltext(?:\s+(?:key|index))?|spatial(?:\s+(?:key|index))?|key|index|foreign key)\b[^()]*\(\s*([^),\s(]+)/i);
  return m ? name(m[1]) : null;
};

// ── Where a project declares its server version ────────────────────────────────────────────────────────

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const COMPOSE = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'docker-compose.override.yml'];

const fromText = (text) => {
  const found = [];
  for (const m of text.matchAll(/^\s*(?:-\s*)?image:\s*["']?(?:docker\.io\/(?:library\/)?)?(mysql|mariadb)(?::|\/)?([\d][\w.-]*)/gim)) found.push(`${m[1]}-${m[2]}`);
  return found;
};

// The server version declared next to the migrations: a compose file or CI workflow image, or .tool-versions.
// Returns { version, evidence } only when every declaration found agrees.
export const projectMysqlVersion = (path, limit = 8) => {
  let dir = resolve(path);
  if (existsSync(dir) && !readdirSafe(dir)) dir = dirname(dir);
  for (let n = 0; n < limit; n++) {
    const hits = [];
    for (const f of COMPOSE) for (const v of fromText(read(join(dir, f)))) hits.push({ v, from: f });
    const tools = read(join(dir, '.tool-versions')).match(/^(mysql|mariadb)\s+(\d[\w.]*)/im);
    if (tools) hits.push({ v: `${tools[1]}-${tools[2]}`, from: '.tool-versions' });
    const wf = join(dir, '.github', 'workflows');
    for (const f of readdirSafe(wf) ?? []) if (/\.ya?ml$/i.test(f)) for (const v of fromText(read(join(wf, f)))) hits.push({ v, from: `.github/workflows/${f}` });
    const parsed = hits.map((h) => ({ ...h, parsed: parseMysqlVersion(h.v) })).filter((h) => h.parsed);
    if (parsed.length) {
      const labels = new Set(parsed.map((h) => h.parsed.label));
      return labels.size === 1 ? { version: parsed[0].parsed, evidence: `${parsed[0].from} in ${dir}` } : null;
    }
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
};

function readdirSafe(dir) { try { return readdirSync(dir); } catch { return null; } }
