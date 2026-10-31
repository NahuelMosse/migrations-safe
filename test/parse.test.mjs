import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSql, parse, splitTopLevel } from '../skills/migrations-safe/scripts/lib/parse.mjs';
import { findings, ids, lintCli, put, scratch } from './helpers.mjs';

test('MySQL backslash escapes do not end a string early', () => {
  const sql = "INSERT INTO t VALUES ('it\\'s'); DROP TABLE t;";
  const mysql = parse(sql, { dialect: 'mysql' }).statements;
  assert.equal(mysql.length, 2);
  assert.ok(ids(sql, { dialect: 'mysql' }).includes('drop-table'));
  // PostgreSQL (standard strings) reads the same text as two strings
  assert.equal(parse("SELECT 'a\\'; DROP TABLE t; SELECT 'b'", { dialect: 'postgres' }).statements.length, 3);
});

test("E'' strings in PostgreSQL honour backslash escapes", () => {
  assert.equal(parse("SELECT E'it\\'s; still'; DROP TABLE t;").statements.length, 2);
});

test('PostgreSQL block comments nest', () => {
  const sql = '/* outer /* inner */ still a comment; DROP TABLE a; */ DROP TABLE b;';
  const stmts = parse(sql).statements;
  assert.equal(stmts.length, 1);
  assert.match(stmts[0].text, /DROP TABLE b/);
  assert.ok(ids(sql).includes('drop-table'));
});

test('MySQL block comments do not nest and # starts a comment', () => {
  const stmts = parse('/* a /* b */ DROP TABLE x; # DROP TABLE y;\nDROP TABLE z;', { dialect: 'mysql' }).statements;
  assert.deepEqual(stmts.map((s) => s.text), ['DROP TABLE x', 'DROP TABLE z']);
});

test('line numbers survive comments, strings and dollar quoting', () => {
  const sql = "-- one\n/* two\nthree */\nSELECT 'a\nb';\nDO $$\nBEGIN\nEND\n$$;\nDROP TABLE t;";
  assert.deepEqual(parse(sql).statements.map((s) => s.line), [4, 6, 10]);
});

test('goose StatementBegin/StatementEnd keeps a function body as one statement', () => {
  const sql = '-- +goose Up\n-- +goose StatementBegin\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\nSELECT 2;\n-- +goose StatementEnd\n-- +goose Down\nDROP FUNCTION f;';
  const p = parse(sql);
  assert.equal(p.statements.length, 1);
  assert.equal(p.hasDownSection, true);
  assert.match(p.downSql, /DROP FUNCTION f/);
});

test('single-file markers: down section, no-transaction flags', () => {
  const p = parse('-- migrate:up transaction:false\nSELECT 1;\n-- migrate:down\nSELECT 2;');
  assert.equal(p.markers.noTransaction, true);
  assert.equal(p.markers.dbmate, true);
  assert.equal(p.statements.length, 1);
  assert.equal(parse('-- +goose NO TRANSACTION\n-- +goose Up\nSELECT 1;').markers.noTransaction, true);
});

test('encodings: UTF-8 BOM, UTF-16 with and without BOM', () => {
  const text = 'DROP TABLE t;\n';
  assert.equal(decodeSql(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
  assert.equal(decodeSql(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
  assert.equal(decodeSql(Buffer.from(text, 'utf16le')), text);
  const be = Buffer.from(text, 'utf16le').swap16();
  assert.equal(decodeSql(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), text);
  assert.equal(decodeSql(be), text);
});

test('a UTF-16 file is linted, not skipped (PowerShell 5.1 redirects write UTF-16)', (t) => {
  const dir = scratch(t);
  const sql = 'DROP TABLE orders;\n';
  put(dir, 'bom.sql', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sql, 'utf16le')]));
  put(dir, 'nobom.sql', Buffer.from(sql, 'utf16le'));
  for (const f of ['bom.sql', 'nobom.sql']) {
    const r = lintCli([`${dir}/${f}`, '--format', 'json']);
    assert.equal(r.code, 1, f);
    assert.ok(JSON.parse(r.out).findings.some((x) => x.rule === 'drop-table'));
  }
});

test('splitTopLevel respects parentheses, quotes and dollar quoting', () => {
  assert.deepEqual(splitTopLevel("a numeric(12,2), b text DEFAULT 'x,y', c int"), ['a numeric(12,2)', "b text DEFAULT 'x,y'", 'c int']);
});

test('directives must be comments of their own, name a known rule and give a reason', () => {
  const base = 'ALTER TABLE orders DROP COLUMN note;';
  const ok = findings(`-- migration-lint: allow drop-column -- approved by ana 2026-10-30, backup b-17\n${base}`);
  assert.ok(!ok.some((f) => f.rule === 'drop-column' || f.rule === 'invalid-directive'));

  const noReason = findings(`-- migration-lint: allow drop-column\n${base}`);
  assert.ok(noReason.some((f) => f.rule === 'drop-column'), 'no reason: nothing is silenced');
  assert.ok(noReason.some((f) => f.rule === 'invalid-directive' && f.level === 'warning'));

  const prose = findings(`-- the plan says migration-lint: allow drop-column -- approved\n${base}`);
  assert.ok(prose.some((f) => f.rule === 'drop-column'), 'a prose mention silences nothing');
  assert.ok(prose.some((f) => f.rule === 'invalid-directive'));

  const typo = findings(`-- migration-lint: allow drop-colum -- approved by ana\n${base}`);
  assert.ok(typo.some((f) => f.rule === 'drop-column'));
  assert.match(typo.find((f) => f.rule === 'invalid-directive').message, /unknown rule/);

  const none = findings(`-- migration-lint: allow -- because\n${base}`);
  assert.match(none.find((f) => f.rule === 'invalid-directive').message, /names no rule/);
});

test('allow applies to the statement it precedes or trails, allow-file to the whole file', () => {
  const sql = '-- migration-lint: allow drop-column -- approved by ana\nALTER TABLE a DROP COLUMN x;\nALTER TABLE b DROP COLUMN y;';
  assert.deepEqual(findings(sql).filter((f) => f.rule === 'drop-column').map((f) => f.line), [3]);
  const trailing = 'ALTER TABLE a DROP COLUMN x; -- migration-lint: allow drop-column -- approved by ana\nALTER TABLE b DROP COLUMN y;';
  assert.deepEqual(findings(trailing).filter((f) => f.rule === 'drop-column').map((f) => f.line), [2]);
  const file = '-- migration-lint: allow-file drop-column, missing-lock-timeout -- contract step approved by ana\nALTER TABLE a DROP COLUMN x;\nALTER TABLE b DROP COLUMN y;';
  assert.deepEqual(ids(file, { runner: 'flyway' }), []);
});

test('irreversible needs a recovery plan', () => {
  assert.ok(ids('-- migration-lint: irreversible\nSELECT 1;').includes('invalid-directive'));
  assert.ok(!ids('-- migration-lint: irreversible -- restore from the nightly snapshot\nSELECT 1;').includes('invalid-directive'));
});

test('messages about a bad directive do not echo more of the file than needed', () => {
  const long = 'x'.repeat(500);
  const msg = findings(`-- migration-lint: allow ${long} -- because\nSELECT 1;`).find((f) => f.rule === 'invalid-directive').message;
  assert.ok(msg.length < 200, `${msg.length} chars`);
  assert.ok(!msg.includes(long));
  const kind = findings(`-- migration-lint: ${long} -- because\nSELECT 1;`).find((f) => f.rule === 'invalid-directive').message;
  assert.ok(kind.length < 200);
});
