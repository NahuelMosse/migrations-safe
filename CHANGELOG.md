# Changelog

## 1.2.0

SQL Server, Oracle and Db2 LUW at the depth MySQL got in 1.1.

- `migration-lint` knows three more dialects, detected from strong syntax markers (`GO`, `[x]`, `sp_rename`;
  `/`, `VARCHAR2`, `EXECUTE IMMEDIATE`; `--#SET TERMINATOR`, `ADMIN_CMD`, `SYSPROC.`) and never from
  `GENERATED ... IDENTITY`. `--server-version` (alias `--mysql-version` for MySQL) and `--edition
  standard|enterprise|azure` (SQL Server) / `se2|ee` (Oracle) select version- and edition-dependent rules; the
  default edition is the conservative one. The server version is read from a compose file or CI workflow.
- Parser: `GO [n]` batches, `/` for PL/SQL blocks and procedures, `--#SET TERMINATOR`, `[bracketed]` identifiers,
  `q'[...]'`, T-SQL scripts without semicolons, `EXEC(N'...')` and `EXECUTE IMMEDIATE` read as the SQL they run,
  SQLCMD and SQL*Plus commands skipped, names compared without case on SQL Server, Oracle and Db2.
- SQL Server rules: `mssql-add-not-null-default`, `mssql-alter-column`, `mssql-index-offline`,
  `mssql-online-unsupported-edition`, `mssql-lock-timeout`, `mssql-constraint-with-check`,
  `mssql-constraint-nocheck`; `sp_rename` feeds `rename-column` and `rename-table`; DACPAC table rebuilds are
  checked for lost columns.
- Oracle rules: `oracle-add-column-default`, `oracle-ddl-lock-timeout`, `oracle-ddl-commits-dml`,
  `oracle-index-not-online`, `oracle-online-unsupported-edition`, `oracle-constraint-validate`,
  `oracle-drop-column-rewrites`, `oracle-missing-slash`.
- Db2 rules: `db2-reorg-pending`, `db2-reorg-offline`, `db2-reorg-limit`, `db2-constraint-check`,
  `db2-lock-timeout`.
- Runner profiles: `efcore`, `dbup`, `sqlpackage`; `unsupported-separator` for a `GO`, `/` or terminator the
  runner does not understand; Oracle files are never wrapped in a transaction by any runner; Liquibase
  `runInTransaction:false` and `endDelimiter:` are read.
- `rehearse --engine mssql:<tag>|oracle:<tag>|db2:<tag>` (`--edition standard|enterprise|se2|ee`): SQL Server
  runs Express, Standard Developer or Developer by `MSSQL_PID` and checks the edition it got; Oracle runs
  `gvenzl/oracle-free` and says SE2 is not emulated; Db2 also fails a migration that leaves a table
  REORG-pending. Each engine proves its lock measurement with a self-test before the first migration. Engines
  live in `scripts/lib/engines/`, each with its own password and database.
- Containers and networks carry a `msafe-owner` label (hostname, platform, WSL distro); the sweep of runs that
  were killed removes only its own system's, so two systems sharing one Docker daemon do not remove each
  other's live containers.
- CI jobs `docker-mssql` and `docker-oracle` run on every pull request; `docker-db2` runs on a schedule and on
  demand. `references/mssql.md`, `oracle.md` and `db2.md` give each claim with its version and source.

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
  polled from a second session), and the row and column-fingerprint diff. Durations are taken inside the
  server. `--down` runs up, down, up and compares the schema with the seed. A lock held longer than
  `--lock-budget` (default 2s) fails the run. Lock measurement is proven first with a probe lock (MySQL 5.7's
  disabled instrument is switched on; exit 2 if it still cannot be seen), and a migration whose polling
  session failed is reported `UNMEAS.` and fails the run instead of claiming no lock. PostgreSQL snapshots
  cover every schema; `.sql.gz` seeds are unpacked; a seed or dump that leaves no tables is exit 2.
  The container has no network and is removed on success, failure, SIGINT and SIGTERM (exit 130, 143);
  `--keep` leaves it and prints how to remove it. A hard kill leaves it, and the next run removes containers
  whose process is gone. Exit 2 when docker is missing, its daemon does not answer or the image cannot be pulled.
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
