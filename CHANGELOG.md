# Changelog

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
