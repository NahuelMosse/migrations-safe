# Changelog

## 1.1.0

MySQL and MariaDB at the depth of PostgreSQL, and rehearsal on real servers.

- `migration-lint` has `mysql-*` rules built from the MySQL 8.0/8.4 online DDL tables and the MariaDB
  instant-ALTER documentation: explicit `ALGORITHM` an operation or server version cannot honour
  (`mysql-algorithm-unsupported`), missing `lock_wait_timeout` (`mysql-lock-wait-timeout`), foreign keys with
  `foreign_key_checks=1` and the implicit index they build (`mysql-add-foreign-key`, `mysql-fk-implicit-index`),
  FULLTEXT and SPATIAL indexes, dropping or adding a primary key, charset and collation conversion, ENUM/SET
  changes (append is instant, reorder or storage growth copies), `OPTIMIZE`/`FORCE`/`ENGINE=InnoDB`
  rebuilds, column position, the 64 instant row versions per table, and `CHANGE COLUMN` used to rename.
  Messages name gh-ost or pt-online-schema-change for tables too big for `ALTER`.
- `--mysql-version` (`8.0` default, `8.0.28`, `8.4`, `5.7`, `mariadb-10.6`) selects version-dependent behaviour;
  without it the version is read from a compose file, CI workflow or `.tool-versions` next to the migrations
  when they agree, and a `note:` line says which one was used.
- `references/mysql.md` lists what runs online per operation, metadata-lock behaviour and the limits of gh-ost
  and pt-online-schema-change; `fixtures/good/mysql` and `fixtures/bad/mysql` exercise the rules.
- `rehearse` (also `rehearse-sqlite`) takes `--engine postgres:<tag>|mysql:<tag>|mariadb:<tag>`. It starts a
  throwaway container (`msafe-rehearse-*`, data in memory by default), reaches it only with `docker exec`,
  loads a `.sql` seed or `--dump` (pg_dump plain or custom format, mysqldump, `.gz`), applies migrations in
  order with the runner's transaction wrapping and down sections, and reports per migration the duration, the
  write-blocking locks held (`pg_locks`, `performance_schema.metadata_locks`, MariaDB `METADATA_LOCK_INFO`,
  polled from a second session), and the row and column-fingerprint diff. `--down` runs up, down, up and
  compares the schema with the seed. A lock held longer than `--lock-budget` (default 2s) fails the run.
  The container is removed on success, failure and SIGINT; `--keep` leaves it and prints how to remove it.
  Exit 2 when docker is missing, its daemon does not answer or the image cannot be pulled.
- Docker rehearsal tests run when docker is available and report `skipped: docker not available` otherwise;
  CI has a Linux job that runs them against `postgres:16` and `mysql:8.4`.

## 1.0.0

First release as a Claude Code plugin.

- `migration-lint` reads SQL migrations (PostgreSQL, SQLite, MySQL) from files or stdin and reports data loss,
  changes that break running code, long locks, transaction and rollback problems. Lock rules on existing
  tables are errors; `--fail-on` picks what fails; output as text, JSON (`schemaVersion: 1`), SARIF or GitHub
  annotations. Exit 2 always means it could not run.
- Runner profiles (Prisma, Drizzle, Flyway, Liquibase, goose, dbmate, golang-migrate, Atlas, Alembic, Django,
  Knex, Rails, plain SQL) are detected from the project and decide downs, transaction wrapping, manifests and order
  semantics; dialect is detected from the project or the syntax.
- `--history` checks edited, renamed or deleted applied migrations (merge-base), order and duplicate versions
  (base tip); it refuses shallow clones.
- `allow` directives need a known rule and a reason.
- `rehearse-sqlite` copies a database with `VACUUM INTO` (so WAL data is included), applies migrations the way the runner does, and
  reports rows and columns per table, lost values and new foreign-key orphans.
- Skill, references per rule, runner and rehearsal, trigger evals, fixtures and a `node --test` suite.
