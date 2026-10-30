-- migration-lint: dialect sqlite
DELETE FROM task_audit;
ALTER TABLE tasks DROP COLUMN priority;
