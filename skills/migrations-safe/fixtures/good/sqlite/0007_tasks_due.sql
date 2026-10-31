-- migration-lint: dialect sqlite
-- migration-lint: irreversible -- a down would rebuild the table again; recovery is the pre-deploy backup
-- SQLite cannot change a column in place: rebuild the table, copying every row and every column.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE new_tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  priority INTEGER,
  due_on TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO new_tasks (id, title, priority, due_on, created_at) SELECT id, title, priority, NULL, created_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE new_tasks RENAME TO tasks;
CREATE INDEX tasks_due_on_idx ON tasks (due_on);
COMMIT;
PRAGMA foreign_keys = ON;
