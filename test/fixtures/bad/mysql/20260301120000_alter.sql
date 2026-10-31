ALTER TABLE users MODIFY COLUMN name varchar(10) NOT NULL;
RENAME TABLE legacy_users TO archived_users;
