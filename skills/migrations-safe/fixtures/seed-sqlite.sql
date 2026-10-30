-- Realistic data for the SQLite fixtures: populated tables, NULLs, an empty string, an audit trail.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  priority INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE task_audit (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, action TEXT NOT NULL);
INSERT INTO tasks (id, title, priority) VALUES (1, 'Renew certificate', 2), (2, 'Call supplier', NULL), (3, '', 1);
INSERT INTO task_audit (task_id, action) VALUES (1, 'created'), (2, 'created'), (3, 'created'), (1, 'edited');
