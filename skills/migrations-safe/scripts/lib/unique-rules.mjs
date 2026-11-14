// unique-on-nullable: a UNIQUE constraint or unique index whose key holds a column the migration declares nullable.
// PostgreSQL, MySQL, SQLite and Oracle treat NULLs as distinct for uniqueness, so rows with NULL there never collide.
// Only columns the migration itself declares are judged: a column it does not define is never assumed nullable.
import { ident, name, splitTopLevel, stripLiterals } from './parse.mjs';
import { CONSTRAINT_START, CREATE_RE, parseAlter } from './schema.mjs';

const NOT_NULL = /\bnot null\b|\bprimary key\b|\b(?:big|small)?serial\b|\bidentity\b/i;
const NULLS_NOT_DISTINCT = /\bnulls not distinct\b/i;
const UNIQUE_INDEX = new RegExp(String.raw`^create unique (?:(?:non)?clustered )?index (?:concurrently )?(?:if not exists )?(?:${ident} )?on (?:only )?(${ident})\s*(?:using \w+\s*)?\(`, 'i');
const KEY_PART = new RegExp(String.raw`^(${ident})(?:\s*\(\d+\))?(?: collate \S+)?(?: (?:asc|desc))?(?: nulls (?:first|last))?$`, 'i');

// The text inside the parenthesis that opens at `open`, and what follows it.
const enclosed = (text, open) => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return { inside: text.slice(open + 1, i), after: text.slice(i + 1) };
  }
  return null;
};

// Plain column names of a key list; an expression part is left out, since its nullability is not declared.
const keyColumns = (list) => splitTopLevel(list).map((p) => p.match(KEY_PART)?.[1]).filter(Boolean).map(name);

const keyList = (element, keyword) => {
  const at = element.search(keyword);
  const open = at === -1 ? -1 : element.indexOf('(', at);
  return open === -1 ? null : enclosed(element, open)?.inside ?? null;
};

export const uniqueOnNullable = ({ texts, add }) => {
  const nullable = new Map();
  const keys = [];
  const columns = (table) => { if (!nullable.has(table)) nullable.set(table, new Map()); return nullable.get(table); };
  const define = (k, table, def) => {
    const col = def.match(new RegExp(`^(${ident})\\s+\\S`))?.[1];
    if (!col) return;
    const body = stripLiterals(def);
    columns(table).set(name(col), !NOT_NULL.test(body));
    if (/\bunique\b/i.test(body) && !/\bprimary key\b/i.test(body) && !NULLS_NOT_DISTINCT.test(body))
      keys.push({ k, table, cols: [name(col)], what: `UNIQUE (${name(col)})` });
  };
  const element = (k, table, raw) => {
    const el = stripLiterals(raw).replace(/^constraint \S+ /i, '');
    if (/^primary key\b/i.test(el)) {
      for (const c of keyColumns(keyList(el, /primary key/i) ?? '')) columns(table).set(c, false);
      return;
    }
    if (!/^unique\b/i.test(el) || NULLS_NOT_DISTINCT.test(el)) return;
    const cols = keyColumns(keyList(el, /\bunique\b/i) ?? '');
    if (cols.length) keys.push({ k, table, cols, what: `UNIQUE (${cols.join(', ')})` });
  };

  texts.forEach((t, k) => {
    const create = t.match(CREATE_RE);
    if (create) {
      const table = name(create[1]);
      nullable.set(table, new Map());
      for (const part of splitTopLevel(create[2])) {
        if (CONSTRAINT_START.test(part)) element(k, table, part);
        else define(k, table, part);
      }
      return;
    }
    const index = t.match(UNIQUE_INDEX);
    if (index) {
      const table = name(index[1]);
      const list = enclosed(t, index[0].length - 1);
      if (!list || NULLS_NOT_DISTINCT.test(list.after)) return;
      const where = list.after.match(/\bwhere\b(.*)$/i)?.[1] ?? '';
      const cols = keyColumns(list.inside).filter((c) => !new RegExp(String.raw`(?:^|[\s(.])"?${c}"?\s+is\s+not\s+null\b`, 'i').test(where));
      if (cols.length) keys.push({ k, table, cols, what: `the unique index (${cols.join(', ')})` });
      return;
    }
    const alter = parseAlter(t);
    if (!alter) return;
    const { table } = alter;
    for (const a of alter.actions) {
      let m;
      if ((m = a.match(/^add (?:column )?(?:if not exists )?(.*)$/is))) {
        if (CONSTRAINT_START.test(m[1])) element(k, table, m[1]);
        else {
          const defs = m[1].startsWith('(') ? splitTopLevel(m[1].replace(/^\(|\)$/g, '')) : [m[1]];
          defs.forEach((d) => define(k, table, d));
        }
      } else if ((m = a.match(new RegExp(String.raw`^alter (?:column )?(${ident}) (set|drop) not null\b`, 'i')))) {
        if (columns(table).has(name(m[1]))) columns(table).set(name(m[1]), m[2].toLowerCase() === 'drop');
      } else if ((m = a.match(new RegExp(String.raw`^modify (?:column )?\(?(${ident})\s+(.*)$`, 'i')))) {
        const cols = columns(table);
        if (!cols.has(name(m[1]))) continue;
        if (/\bnot null\b/i.test(m[2])) cols.set(name(m[1]), false);
        else if (/\bnull\b/i.test(m[2])) cols.set(name(m[1]), true);
      } else if ((m = a.match(new RegExp(String.raw`^drop (?:column )?(?:if exists )?(${ident})`, 'i')))) {
        columns(table).delete(name(m[1]));
      } else if ((m = a.match(new RegExp(String.raw`^rename (?:column )?(${ident}) to (${ident})`, 'i')))) {
        const cols = columns(table);
        if (cols.has(name(m[1]))) { cols.set(name(m[2]), cols.get(name(m[1]))); cols.delete(name(m[1])); }
      }
    }
  });

  for (const key of keys) {
    const open = key.cols.filter((c) => nullable.get(key.table)?.get(c) === true);
    if (!open.length) continue;
    add(key.k, 'unique-on-nullable', `${key.what} on ${key.table} does not stop duplicates when ${open.join(' or ')} is NULL: NULLs are distinct for uniqueness, so any number of rows with NULL there pass it — make ${open.length > 1 ? 'the columns' : 'the column'} NOT NULL, use NULLS NOT DISTINCT (PostgreSQL 15+), store a sentinel value instead of NULL, or allow this finding when repeated NULLs are intended for an optional value`);
  }
};
