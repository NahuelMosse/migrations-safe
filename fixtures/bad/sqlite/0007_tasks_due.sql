-- migration-lint: dialect sqlite
ALTER TABLE tasks ADD COLUMN due_on TEXT NOT NULL;
