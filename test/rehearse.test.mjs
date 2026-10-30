import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { FIXTURES, put, rehearseCli, scratch } from './helpers.mjs';

const SEED = join(FIXTURES, 'seed-sqlite.sql');
const REBUILD_DROPPING_PRIORITY = `PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE new_tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO new_tasks (id, title, created_at) SELECT id, title, created_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE new_tasks RENAME TO tasks;
COMMIT;
PRAGMA foreign_keys=ON;
`;

test('a rebuild that drops a populated column loses data and fails the rehearsal (C2)', (t) => {
  const dir = scratch(t);
  const file = put(dir, '0007_rebuild.sql', REBUILD_DROPPING_PRIORITY);
  const r = rehearseCli([SEED, file]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lost: tasks\.priority dropped with 2 non-NULL value/);
  assert.match(r.out, /columns: -priority \(2 non-NULL\)/);
  const allowed = rehearseCli([SEED, file, '--allow-loss', 'tasks.priority']);
  assert.equal(allowed.code, 0, allowed.out);
});

test('a rename of a column is not reported as a loss', (t) => {
  const dir = scratch(t);
  const file = put(dir, '0001_rename.sql', 'ALTER TABLE tasks RENAME COLUMN priority TO urgency;\n');
  const r = rehearseCli([SEED, file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /priority renamed to urgency\?/);
});

test('every table is printed with its row count, and added columns are listed', () => {
  const r = rehearseCli([SEED, join(FIXTURES, 'good/sqlite/0007_tasks_due.sql')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /task_audit\s+rows 4\b/);
  assert.match(r.out, /tasks\s+rows 3\s+columns: \+due_on/);
  assert.match(r.out, /all ran, no rows or values lost, no new orphans/);
});

test('column non-NULL counts that shrink are losses even when the rows stay', (t) => {
  const dir = scratch(t);
  const file = put(dir, '0001_wipe.sql', 'UPDATE tasks SET priority = NULL WHERE id = 1;\n');
  const r = rehearseCli([SEED, file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /tasks\.priority non-NULL 2→1/);
});

const PARENT_CHILD = `CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id) ON DELETE CASCADE);
INSERT INTO parent (id) VALUES (1), (2);
INSERT INTO child (id, parent_id) VALUES (1, 1), (2, 2), (3, 2);
`;

test('orphans that already exist do not fail the rehearsal; new ones do (M6)', (t) => {
  const dir = scratch(t);
  const seed = put(dir, 'seed.sql', `${PARENT_CHILD}INSERT INTO child (id, parent_id) VALUES (9, 99);\n`);
  const harmless = put(dir, '0001_harmless.sql', 'ALTER TABLE parent ADD COLUMN note TEXT;\n');
  assert.equal(rehearseCli([seed, harmless]).code, 0);
  const creates = put(dir, '0002_orphan.sql', 'DELETE FROM parent WHERE id = 1;\n');
  const r = rehearseCli([seed, harmless, creates, '--foreign-keys', 'off']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /new orphan foreign key row\(s\): 1/);
});

test('foreign_keys follows the runner: a wrapped file cannot switch it off, so DROP TABLE cascades (H5)', (t) => {
  const dir = scratch(t);
  const seed = put(dir, 'seed.sql', PARENT_CHILD);
  const rebuild = `PRAGMA foreign_keys=OFF;
CREATE TABLE new_parent (id INTEGER PRIMARY KEY, label TEXT);
INSERT INTO new_parent (id) SELECT id FROM parent;
DROP TABLE parent;
ALTER TABLE new_parent RENAME TO parent;
PRAGMA foreign_keys=ON;
`;
  const goose = put(dir, '0001_goose.sql', `-- +goose Up\n${rebuild}-- +goose Down\nSELECT 1;\n`);
  const plain = put(dir, '0001_plain.sql', rebuild);
  const wrapped = rehearseCli([seed, goose, '--foreign-keys', 'on']);
  assert.equal(wrapped.code, 1, wrapped.out);
  assert.match(wrapped.out, /runner: goose/);
  assert.match(wrapped.out, /child\s+rows 3→0/);
  const raw = rehearseCli([seed, plain, '--foreign-keys', 'on']);
  assert.equal(raw.code, 0, raw.out);
});

test('--down with no files runs the down sections of single-file migrations (M5)', (t) => {
  const dir = scratch(t);
  const file = put(dir, '0001_note.sql', '-- migrate:up\nALTER TABLE tasks ADD COLUMN note TEXT;\n\n-- migrate:down\nALTER TABLE tasks DROP COLUMN note;\n');
  const r = rehearseCli([SEED, file, '--down']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ran\s+down\s/);
  assert.match(r.out, /1 up\(s\), 1 down\(s\)/);
  const noDown = put(dir, '0002_nodown.sql', 'ALTER TABLE tasks ADD COLUMN z TEXT;\n');
  const bad = rehearseCli([SEED, noDown, '--down']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /has no down section/);
});

test('--down with separate files still works, and a down that does not run fails', (t) => {
  const dir = scratch(t);
  const up = put(dir, '0001.up.sql', 'ALTER TABLE tasks ADD COLUMN note TEXT;\n');
  const down = put(dir, '0001.down.sql', 'ALTER TABLE tasks DROP COLUMN note;\n');
  assert.equal(rehearseCli([SEED, up, '--down', down]).code, 0);
  const broken = put(dir, '0002.down.sql', 'ALTER TABLE tasks DROP COLUMN missing_col;\n');
  assert.equal(rehearseCli([SEED, up, '--down', broken]).code, 1);
});

test('after a failed up the rest is skipped instead of cascading failures', (t) => {
  const dir = scratch(t);
  const a = put(dir, '0001_a.sql', 'ALTER TABLE nope ADD COLUMN x TEXT;\n');
  const b = put(dir, '0002_b.sql', 'ALTER TABLE tasks ADD COLUMN y TEXT;\n');
  const r = rehearseCli([SEED, a, b]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAILED\s+up\s/);
  assert.match(r.out, /SKIPPED up\s.*0002_b/);
  assert.match(r.out, /stopped at/);
  assert.ok(!/ran\s+up/.test(r.out));
});

test('a database in WAL mode is copied with the data still in its -wal file (backup API, not a file copy)', (t) => {
  const dir = scratch(t);
  const path = join(dir, 'app.db');
  const live = new DatabaseSync(path);
  try {
    live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);');
    live.exec("INSERT INTO notes (body) VALUES ('a'), ('b'), ('c');");
    const file = put(dir, '0001_x.sql', 'ALTER TABLE notes ADD COLUMN tag TEXT;\n');
    const r = rehearseCli([path, file]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /notes\s+rows 3\s+columns: \+tag/);
  } finally {
    live.close();
  }
});

test('the original database is never changed', (t) => {
  const dir = scratch(t);
  const path = join(dir, 'app.db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('a');");
  db.close();
  const file = put(dir, '0001_x.sql', 'DROP TABLE notes;\n');
  assert.equal(rehearseCli([path, file]).code, 1);
  const after = new DatabaseSync(path, { readOnly: true });
  assert.equal(after.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
  after.close();
});

test('argument and file errors are exit 2', (t) => {
  const dir = scratch(t);
  assert.equal(rehearseCli([SEED]).code, 2);
  assert.equal(rehearseCli([SEED, join(dir, 'missing.sql')]).code, 2);
  assert.equal(rehearseCli([join(dir, 'missing.sqlite'), SEED]).code, 2);
  assert.equal(rehearseCli([SEED, SEED, '--runner', 'rails']).code, 2);
  assert.equal(rehearseCli([SEED, SEED, '--foreign-keys', 'maybe']).code, 2);
});

test('the bad and good fixtures rehearse as documented', () => {
  assert.equal(rehearseCli([SEED, join(FIXTURES, 'good/sqlite/0007_tasks_due.sql')]).code, 0);
  const bad8 = rehearseCli([SEED, join(FIXTURES, 'bad/sqlite/0008_tasks_cleanup.sql')]);
  assert.equal(bad8.code, 1);
  assert.match(bad8.out, /task_audit 4→0 rows/);
  const bad7 = rehearseCli([SEED, join(FIXTURES, 'bad/sqlite/0007_tasks_due.sql')]);
  assert.equal(bad7.code, 1);
  assert.match(bad7.out, /FAILED\s+up/);
});
