// SQL reading: decoding, statement splitting, comments, directives and runner markers.

const DOWN_MARKER = /^\s*--\s*(\+goose\s+down|\+migrate\s+down|migrate:down)\b/i;
const DIRECTIVE_AT_START = /^migration-lint:\s*(\S+)\s*(.*)$/is;

export const KNOWN_DIRECTIVES = ['allow', 'allow-file', 'irreversible', 'dialect'];

// Bytes to text: UTF-8 with or without BOM, UTF-16 with BOM, UTF-16 LE/BE without BOM (PowerShell 5.1 `>`).
export const decodeSql = (buf) => {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  if (buf.length >= 4 && buf[0] !== 0 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  if (buf.length >= 4 && buf[0] === 0 && buf[1] !== 0 && buf[2] === 0) return Buffer.from(buf).swap16().toString('utf16le');
  return buf.toString('utf8');
};

const IS_WORD = /[\w$]/;

// End index (exclusive) of the quoted token that starts at `i`.
const quotedEnd = (sql, i, dialect) => {
  const q = sql[i];
  const prev = sql[i - 1];
  const backslash = dialect === 'mysql' && q !== '`'
    || (dialect === 'postgres' && q === "'" && /[eE]/.test(prev ?? '') && !IS_WORD.test(sql[i - 2] ?? ' '));
  let j = i + 1;
  while (j < sql.length) {
    if (backslash && sql[j] === '\\') { j += 2; continue; }
    if (sql[j] === q) {
      if (sql[j + 1] === q) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
};

const countLines = (s) => (s.match(/\n/g) || []).length;

// Splits SQL into the statements of the "up" part. Returns statements with their first line, the
// directive comments, the block comments, the down section (single-file formats) and runner markers.
export const parse = (sql, { dialect = 'postgres' } = {}) => {
  const statements = [];
  const directives = [];
  const comments = [];
  const markers = { goose: false, dbmate: false, sqlMigrate: false, noTransaction: false };
  let hasDownSection = false;
  let downSql = '';
  let upEnd = sql.length;
  let buf = '';
  let start = null;
  let line = 1;
  let i = 0;
  let lastEnd = 0;
  let rawBlock = false;
  const nested = dialect === 'postgres';

  const push = () => {
    if (buf.trim()) { statements.push({ text: buf.trim(), line: start }); lastEnd = line; }
    buf = '';
    start = null;
  };
  const stmtIndexForComment = () => (!buf.trim() && lastEnd === line ? statements.length - 1 : statements.length);
  const inOpenBody = () => {
    if (rawBlock) return true;
    if (!/^\s*create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?trigger\b/i.test(buf)) return false;
    const bare = buf.replace(/'(?:[^']|'')*'/g, "''");
    const opens = (bare.match(/\b(?:begin|case)\b/gi) || []).length;
    const closes = (bare.match(/\bend\b/gi) || []).length;
    return opens > closes;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--' || (dialect === 'mysql' && ch === '#')) {
      const end = sql.indexOf('\n', i);
      const comment = sql.slice(i, end === -1 ? sql.length : end);
      const body = comment.replace(/^(--|#)\s*/, '').trimEnd();
      if (DOWN_MARKER.test(comment)) {
        hasDownSection = true;
        upEnd = i;
        downSql = end === -1 ? '' : sql.slice(end + 1);
        push();
        break;
      }
      if (/^\+goose\s+no\s+transaction\b/i.test(body) || /^\+migrate\s+up\b.*\bnotransaction\b/i.test(body)
        || /^migrate:up\b.*\btransaction:false\b/i.test(body) || /^atlas:txmode\s+none\b/i.test(body)) markers.noTransaction = true;
      if (/^\+goose\b/i.test(body)) markers.goose = true;
      if (/^migrate:(up|down)\b/i.test(body)) markers.dbmate = true;
      if (/^\+migrate\b/i.test(body)) markers.sqlMigrate = true;
      if (/^\+goose\s+statementbegin\b/i.test(body)) rawBlock = true;
      if (/^\+goose\s+statementend\b/i.test(body)) { rawBlock = false; push(); }
      const d = body.match(DIRECTIVE_AT_START);
      const statement = stmtIndexForComment();
      if (d) {
        const rest = d[2].trim();
        const cut = rest.search(/(^|\s)--(\s|$)/);
        directives.push({
          kind: d[1].toLowerCase(), arg: (cut === -1 ? rest : rest.slice(0, cut)).trim(),
          reason: cut === -1 ? '' : rest.slice(cut).replace(/^\s*--\s*/, '').trim(), line, statement,
        });
      } else if (/migration-lint:/i.test(body)) {
        directives.push({ kind: 'misplaced', arg: body, reason: '', line, statement });
      }
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (nested && sql.startsWith('/*', j)) { depth++; j += 2; }
        else if (sql.startsWith('*/', j)) { depth--; j += 2; }
        else j++;
      }
      const body = sql.slice(i, j);
      comments.push({ text: body, line, statement: stmtIndexForComment() });
      line += countLines(body);
      buf += ' ';
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const j = quotedEnd(sql, i, dialect);
      const lit = sql.slice(i, j);
      if (start === null) start = line;
      line += countLines(lit);
      buf += lit;
      i = j;
      continue;
    }
    if (ch === '$' && !IS_WORD.test(sql[i - 1] ?? ' ')) {
      const dollar = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (dollar) {
        const tag = dollar[0];
        const end = sql.indexOf(tag, i + tag.length);
        const lit = sql.slice(i, end === -1 ? sql.length : end + tag.length);
        if (start === null) start = line;
        line += countLines(lit);
        buf += lit;
        i += lit.length;
        continue;
      }
    }
    if (ch === ';') {
      if (inOpenBody()) { buf += ch; i++; continue; }
      push();
      i++;
      continue;
    }
    if (ch === '\n') line++;
    if (start === null && /\S/.test(ch)) start = line;
    buf += ch;
    i++;
  }
  push();
  return { statements, directives, comments, hasDownSection, downSql, upSql: sql.slice(0, upEnd), markers };
};

// Text of the sections of a single-file migration (goose, dbmate, sql-migrate); whole text when it has no marker.
export const upPart = (sql) => parse(sql).upSql;
export const downPart = (sql) => { const p = parse(sql); return p.hasDownSection ? p.downSql : null; };

// ── Small SQL text helpers ───────────────────────────────────────────────────────────────────────

export const ident = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)(?:\.(?:"[^"]+"|\`[^\`]+\`|[\w$]+))*`;
// Last part of a possibly qualified identifier: unquoted names are case-folded, quoted ones keep their case.
export const name = (raw) => {
  const last = (raw ?? '').trim().match(/("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)$/)?.[1] ?? '';
  return /^["`[]/.test(last) ? last.slice(1, -1) : last.toLowerCase();
};
export const flat = (s) => s.replace(/\s+/g, ' ');
export const stripLiterals = (s) => s.replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/\$([A-Za-z_]\w*)?\$.*?\$\1\$/gs, "''");

// Splits on `sep` outside parentheses, quotes and dollar quotes.
export const splitTopLevel = (text, sep = ',') => {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length && !(text[j] === ch && text[j + 1] !== ch)) j += text[j] === ch ? 2 : 1;
      i = j;
    } else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
};
