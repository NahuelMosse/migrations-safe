// SQL Server knowledge the rules need: which editions run operations online, what an ALTER TABLE action
// is, and the shape of CREATE INDEX, ALTER INDEX and sp_rename. Edition facts: Enterprise (and Developer,
// Evaluation, Azure SQL) run online index operations and online schema changes; Standard and Express do not
// (Editions and supported features of SQL Server 2022 and 2025, "High availability" table).
import { ident, name, stripLiterals } from './parse.mjs';

export const isEnterprise = (edition) => edition === 'enterprise' || edition === 'azure';
export const ONLINE_ON = /\bonline\s*=\s*on\b/i;
export const RESUMABLE_ON = /\bresumable\s*=\s*on\b/i;
export const WAIT_AT_LOW_PRIORITY = /\bwait_at_low_priority\b/i;
// ALTER COLUMN ... WITH (ONLINE = ON) exists from SQL Server 2016.
export const ONLINE_ALTER_COLUMN_YEAR = 2016;

// Words that start an ALTER TABLE action; anything else after a comma continues the previous ADD or DROP COLUMN.
const ACTION_START = /^(?:add|drop|alter|with|set|check|nocheck|enable|disable|switch|rebuild|reorganize|trigger|no|lock_escalation|change_tracking|sparse|on|partition|data_deletion|system_versioning)\b/i;

// `ADD a int, b int` and `DROP COLUMN a, b` list their elements without repeating the verb.
export const normalizeTsqlActions = (actions) => {
  let last = null;
  return actions.map((a) => {
    if (!ACTION_START.test(a) && last) return `${last} ${a}`;
    if (/^add\b/i.test(a)) last = 'add';
    else if (/^drop\s+column\b/i.test(a)) last = 'drop column';
    else if (/^drop\s+constraint\b/i.test(a)) last = 'drop constraint';
    else last = null;
    return a;
  });
};

const EXPRESSION = /\bdefault\s*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|[\w@.$]+(?:\s*\([^)]*\))?)/i;
// Not a runtime constant (the same value for every row): NEWID(), NEXT VALUE FOR, RAND(), a subquery.
const VOLATILE = /\b(?:newid|newsequentialid|rand|crypt_gen_random|next\s+value\s+for|select)\b/i;

// { present, constant } for the DEFAULT of a column definition.
export const defaultOf = (def) => {
  const m = stripLiterals(def).match(EXPRESSION);
  return m ? { present: true, constant: !VOLATILE.test(m[1]) } : { present: false, constant: true };
};

export const CREATE_INDEX = new RegExp(String.raw`^create\s+(?:unique\s+)?(?:(?:non)?clustered\s+)?(?:(?:non)?clustered\s+)?(?:columnstore\s+)?index\s+(?:${ident})\s+on\s+(${ident})`, 'i');
export const ALTER_INDEX = new RegExp(String.raw`^alter\s+index\s+(?:${ident}|all)\s+on\s+(${ident})\s+(rebuild|reorganize|disable|set|resume|abort|pause)\b`, 'i');
const SP_RENAME = /^exec(?:ute)?\s+(?:sys\.)?sp_rename\s+(?:@objname\s*=\s*)?N?'([^']*)'\s*,\s*(?:@newname\s*=\s*)?N?'([^']*)'(?:\s*,\s*(?:@objtype\s*=\s*)?N?'(\w+)')?/i;

const parts = (qualified) => qualified.split('.').map((p) => p.replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''));

// { kind: 'column' | 'object', table, from, to } for EXEC sp_rename, or null; other object types (INDEX, STATISTICS) are not renames of data the code reads.
export const spRename = (text) => {
  const m = text.match(SP_RENAME);
  if (!m) return null;
  const type = (m[3] ?? 'OBJECT').toUpperCase();
  const old = parts(m[1]);
  if (type === 'COLUMN') return { kind: 'column', table: name(old.at(-2) ?? ''), from: old.at(-1), to: m[2] };
  if (type === 'OBJECT') return { kind: 'object', table: name(old.at(-1)), from: old.at(-1), to: m[2] };
  return null;
};
