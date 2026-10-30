#!/usr/bin/env bash
set -euo pipefail

mkdir -p db/migrations
cat > db/seed.sql <<'SQL'
CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, priority INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE task_audit (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE, action TEXT NOT NULL);
INSERT INTO tasks (id, title, priority) VALUES (1, 'Renew certificate', 2), (2, 'Call supplier', 1), (3, 'File taxes', 3);
INSERT INTO task_audit (task_id, action) VALUES (1, 'created'), (2, 'created'), (3, 'created'), (1, 'edited');
SQL
cat > db/migrations/0007_tasks_cleanup.sql <<'SQL'
PRAGMA foreign_keys=OFF;
CREATE TABLE new_tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO new_tasks (id, title, created_at) SELECT id, title, created_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE new_tasks RENAME TO tasks;
PRAGMA foreign_keys=ON;
SQL
