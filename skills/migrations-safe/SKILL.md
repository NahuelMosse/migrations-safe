---
name: migrations-safe
description: Write and review database schema migrations so they do not lose data, break the code already running, or lock a busy table. Use when creating or reviewing a migration file (raw SQL, Prisma, Drizzle, Flyway, Liquibase, goose, dbmate, golang-migrate, Atlas, Alembic, Django, Knex, Rails), when dropping, renaming or retyping columns or tables, adding NOT NULL or an index to a populated table, when a migration failed or locked production, when an applied migration was edited, or when two branches' migrations collide. Not for data modelling from scratch, SELECT or index tuning, ORM usage, moving data between database products, or upgrading the database server.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/*)
---

# Safe migrations

A migration runs once, against data you have not seen, while the previous version of the code is still
serving traffic. It is safe when three things hold: **no data is lost** without a decision, **the code
already deployed keeps working** against the new schema, and **no lock stops traffic** for longer than a
few seconds. Two more concern the history: what is already applied is never rewritten, and every
environment applies the new files in the same order.

## Method

### 1. Lint every new migration before it is applied

```bash
node "${CLAUDE_SKILL_DIR}/scripts/migration-lint.mjs" db/migrations/20261030_add_due_on.sql
node "${CLAUDE_SKILL_DIR}/scripts/migration-lint.mjs" --history          # migrations new in this branch + git checks
node "${CLAUDE_SKILL_DIR}/scripts/migration-lint.mjs" prisma/migrations --fail-on warning
python manage.py sqlmigrate shop 0042 | node "${CLAUDE_SKILL_DIR}/scripts/migration-lint.mjs" - --runner django
```

PowerShell: `node "$env:CLAUDE_SKILL_DIR/scripts/migration-lint.mjs" <path>`.

- Needs Node 22.13+. No database needed; reads `.sql` files or SQL on stdin (`-`).
- The runner (Prisma, Drizzle, Flyway, Liquibase, goose, dbmate, golang-migrate, Atlas, Alembic, Django,
  Knex, or plain SQL) and the dialect (PostgreSQL, SQLite, MySQL) are detected from the project; override
  with `--runner` and `--dialect`. Details per runner, and how to feed Alembic, Django, Knex and Rails:
  [references/runners.md](references/runners.md). Read it when the project uses any of them.
- Exit 0 nothing at the failure level, 1 findings, **2 could not run, which is never a pass** (0 files
  linted, shallow clone, bad arguments).
- `--fail-on warning|error|<rule>,...` sets what fails (default: errors; `--strict` is `warning`).
  `--format json|sarif|github` for machines (JSON has `schemaVersion: 1`).
- `--history` compares with the base (`origin/main`, `main`, `--base <ref>`): edited, renamed or deleted
  applied migrations, a new one that sorts before the base's newest, duplicate versions. It needs full
  history: in CI use `fetch-depth: 0`. Re-run it against the current tip of main just before merging.
- For PostgreSQL also run `squawk` as a second opinion: the linter here is regex-based, not a parser.

### 2. Classify each change: additive, or several releases?

Additive and safe in one step: a new table, a new nullable column, a new column with a **constant**
default (PostgreSQL 11+, MySQL 8 instant), an index built concurrently, a constraint added `NOT VALID`.

Anything that removes, renames or narrows needs **expand, migrate, contract**, each its own deploy,
because during a rolling deploy (and after a rollback) the old code runs against the new schema:

| Step | Schema | Code |
|---|---|---|
| Expand | Add the new column or table next to the old one | Writes both; reads old |
| Migrate | Backfill in batches; then enforce (NOT NULL, FK) with `NOT VALID` plus `VALIDATE` | Reads new (flag if it matters) |
| Contract | Drop the old one in a later release, once no deployed version reads it | Old path deleted |

For ORMs that cache column lists (Rails, Hibernate), tell the ORM to ignore the column (`ignored_columns`,
`@Transient`) one release before dropping it. Tools that automate expand: pgroll, Reshape; for MySQL tables
too big for `ALTER`: gh-ost, pt-online-schema-change.

### 3. Fix findings by root cause

Every rule, why it breaks, the correct fix and the wrong one: [references/rules.md](references/rules.md).
Load it when a finding needs explaining. In short:

- **Data loss** (`drop-*`, `truncate`, `delete-all`, `update-all`, `rebuild-drops-column`,
  `prisma-data-loss-warning`): contract step only, verified backup, recorded approval; backfills in
  batches outside the DDL migration.
- **Breaks running code** (`rename-*`, `change-column-type`, `not-null-without-default`): expand, migrate,
  contract. Never a fake default to make NOT NULL pass.
- **Locks** (`set-not-null`, `constraint-*`, `*-index-*`, `volatile-default`, `rewriting-column`,
  `missing-lock-timeout`): `NOT VALID` then `VALIDATE`, `CONCURRENTLY` in its own no-transaction file,
  `SET lock_timeout` before the first `ALTER`.
- **Transactions and rollback** (`concurrently-in-transaction`, `transaction-conflict`, `not-atomic`,
  `missing-down`): know whether the runner wraps the file; a down that runs, or an `irreversible` plan.
- **History** (`applied-migration-changed`, `out-of-order`, `duplicate-sequence`): restore the applied file
  and write a **new** migration; renumber the branch's migration, never main's. `flyway repair`,
  `alembic stamp`, `prisma migrate resolve`, `atlas migrate hash` are a person's recorded decision.

Silencing is a recorded decision, as a comment of its own that starts with `migration-lint:`, a known
rule, and a reason; anything else silences nothing and raises `invalid-directive`:

```sql
-- migration-lint: allow drop-column -- contract step, approved by <who> on <date>, backup <id>
-- migration-lint: allow-file not-atomic -- the runner wraps each file in a transaction
-- migration-lint: irreversible -- restore from the nightly snapshot if needed
```

A migration is also **self-contained**: it does not import the application's current models, enums or
services (Django `apps.get_model`; Rails: a minimal model class inside the migration). And the schema
history must match the model: `makemigrations --check`, `alembic check`, `prisma migrate diff --exit-code`,
`drizzle-kit check`.

SQLite cannot alter most column properties, so tools rebuild the table (create `new_t`, `INSERT ... SELECT`,
drop, rename). The linter checks the rebuild against the table as earlier migrations in the folder (or
`--schema <sql>`) left it, and reads Prisma's `Warnings` comment; the rehearsal checks the data.

### 4. Rehearse on a copy with realistic data

An empty test database proves almost nothing. For SQLite:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/rehearse-sqlite.mjs" app.db db/migrations/0007_due.sql
node "${CLAUDE_SKILL_DIR}/scripts/rehearse-sqlite.mjs" seed.sql 0007.up.sql --down 0007.down.sql   # up, down, up
```

It works on a copy and reports, per table, rows and columns added, dropped or emptied; it fails on lost
rows or values, new foreign-key orphans and migrations that do not run, and it emulates the runner's
transaction wrapping and `foreign_keys` setting. For PostgreSQL and MySQL the rehearsal is a restored
copy on the same engine and version: [references/rehearsal.md](references/rehearsal.md) has the steps and
how to read the SQLite output. Load it before rehearsing.

### 5. Verify and report

Finish when the linter shows **0 errors, or each remaining finding is allowed in the file with its
reason**. Do not loop on warnings by editing around them, and do not add an `allow` to get green.

- Linter exit code and last line per run; every `allow` with its reason.
- Rehearsal: where (engine, version, data size), duration, rows and columns before and after, the N-1
  code's test suite against the migrated schema.
- The release plan when the change has several steps: which deploy carries which migration.
- What could not run, said as such ("rehearsal could not run: no copy of production available").

## Limits

- Regex over statements, not a SQL parser: standard DDL only; `DO` blocks and procedural bodies are skipped.
- "Existing table" means not created earlier in the same file (or earlier new migration with `--history`).
  Table sizes are unknown: a lock error on a ten-row table can be allowed with that reason; on a
  hundred-million-row table it is an outage.
- ORM migrations in Ruby, Python or TypeScript are not read; lint the SQL they produce.
- No SQL Server or Oracle rules. MySQL coverage is `ALGORITHM`, type changes, renames and the generic rules.
