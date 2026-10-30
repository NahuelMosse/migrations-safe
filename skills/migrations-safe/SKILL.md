---
name: migrations-safe
description: Write and review database schema migrations that do not lose data, break the code already running, or lock a busy table — dropping or renaming columns and tables, changing a column type, adding NOT NULL to a populated table, indexes and constraints that block writes, missing down/rollback, expand–contract for renames, backfills in batches, editing a migration that was already applied, migrations from two branches that collide or sort out of order, and rehearsing a migration on a copy with realistic data. Use when creating or reviewing a migration file (raw SQL, Prisma, Drizzle, Rails, Django, Alembic, Flyway, Knex, goose, dbmate), when a migration failed or locked production, or when a migration conflicts after a merge. Not for designing a data model from scratch, query or index tuning of SELECTs, ORM usage in application code, moving data between two database products (an ETL/platform migration), or upgrading the database server version.
---

# Safe migrations

A migration runs once, against data you have not seen, while the previous version of the code is still
serving traffic. It is safe when three things hold: **no data is lost** without a decision, **the code
already deployed keeps working** against the new schema, and **no lock stops traffic** for longer than
a few seconds. Plus two about the history: what is already applied is never rewritten, and every
environment can apply the new files in the same order.

## Method

### 1. Lint every new migration before it is applied

```bash
node <skill-dir>/scripts/migration-lint.mjs db/migrations/20261030_add_due_on.sql      # one file
node <skill-dir>/scripts/migration-lint.mjs --history                                   # the migrations new in this branch + history checks
node <skill-dir>/scripts/migration-lint.mjs prisma/migrations --dialect sqlite --strict
```

Static, no database needed. Reads `.sql` (Prisma `migration.sql`, Drizzle, Flyway `V…__`, goose/dbmate/
sql-migrate files with an Up/Down section, `x.up.sql` + `x.down.sql`). For Rails, Django or Alembic, lint
the SQL the tool will run: `rails db:migrate:status` + `strong_migrations`, `python manage.py sqlmigrate
<app> <n>`, `alembic upgrade <rev> --sql`. Exit 0 no errors, 1 errors (warnings too with `--strict`),
2 could not run — never report a 2 as passed.

`--history` compares with the base (merge-base of HEAD and `origin/main`/`main`/`master`, or `--base
<ref>`) and fails when a migration that exists there was edited, renamed or deleted, when a new one sorts
before the base's last, or when two share a sequence. Re-run it against the **current** tip of main
just before merging, not only the merge-base: another branch may have landed a migration since.

### 2. Classify each change: is it additive, or does it need several releases?

Additive and safe in one step: new table, new nullable column, new column with a **constant** default
(PostgreSQL 11+, MySQL 8 instant), new index built concurrently, a constraint added `NOT VALID`.

Anything that removes, renames or narrows needs **expand → migrate → contract**, each step its own
deploy, because during a rolling deploy (and after a rollback) the old code runs against the new schema:

| Step | Schema | Code |
|---|---|---|
| Expand | Add the new column/table next to the old one | Writes both; reads old |
| Migrate | Backfill in batches; then enforce (NOT NULL, FK) with `NOT VALID` + `VALIDATE` | Reads new (feature flag if it matters) |
| Contract | Drop the old one — a later release, once no deployed version reads it | Old path deleted |

For ORMs that cache column lists (Rails, Hibernate), tell the ORM to ignore the column (`ignored_columns`,
`@Transient`) one release before dropping it. Tools that automate the expand phase: pgroll (versioned
views + triggers), Reshape; for MySQL tables too big for `ALTER`, gh-ost or pt-online-schema-change.

### 3. Fix by root cause

| Finding (`rule`) | Why it breaks | Correct | Wrong |
|---|---|---|---|
| `drop-column`, `drop-table`, `truncate`, `delete-all` | Data gone; running code selects/inserts the column | Contract step after a release that stopped using it; verified backup; recorded approval as `-- migration-lint: allow <rule> -- <who, when, backup>` | Dropping in the same release that stops using it; "it's unused" without grepping the code and the reports |
| `rename-column`, `rename-table` | Old code uses the old name the second the migration commits | Add new, write both (app or trigger), backfill, switch reads, drop old later; for tables, a view with the old name during the transition | `RENAME` in one step "because it's fast" — fast for the DB, instant breakage for the app |
| `change-column-type` | Rewrites the table under an exclusive lock; narrowing fails or truncates on real data | New column of the new type, backfill, switch, drop old. Safe in place: `varchar(n)`→`varchar(m>n)`/`text` in PG — allow with the reason | `USING col::int` on a populated table in one step |
| `not-null-without-default` | Fails on a populated table (SQLite fails even empty); old code's INSERTs break | Add nullable → backfill → enforce; or with a constant default if a default is truly right | A fake default (`''`, `0`, `'unknown'`) to make it pass — it becomes data |
| `set-not-null` (PG) | Full scan under ACCESS EXCLUSIVE | `ADD CONSTRAINT c CHECK (col IS NOT NULL) NOT VALID` → next migration `VALIDATE CONSTRAINT c` → `SET NOT NULL` (PG 12+ uses the check, no scan) → drop the check | `SET NOT NULL` directly on a big table |
| `constraint-without-not-valid` (PG) | FK/CHECK validates every row holding a lock that blocks writes | `… NOT VALID`, then `VALIDATE CONSTRAINT` in its own migration (lighter lock) | Disabling triggers or the FK to "speed it up" |
| `constraint-builds-index` (PG) | UNIQUE/PK build their index under ACCESS EXCLUSIVE | `CREATE UNIQUE INDEX CONCURRENTLY`, then `ADD CONSTRAINT … USING INDEX`; find duplicates first | Deleting "duplicates" inside the migration without a decision |
| `index-without-concurrently`, `drop-index-without-concurrently` (PG) | Writes blocked for the whole build | `CREATE/DROP INDEX CONCURRENTLY`, own file, runner's no-transaction mode (Rails `disable_ddl_transaction!`, Django `atomic = False`, dbmate `transaction:false`, Atlas `txmode none`); if it fails, drop the `INVALID` index and retry | Building it at night and hoping |
| `concurrently-in-transaction` | PG rejects it | Separate migration, no transaction | Removing the `CONCURRENTLY` |
| `volatile-default`, `rewriting-column` (PG) | `now()`, `gen_random_uuid()`, serial/identity/stored generated rewrite the table | Add column without default → `ALTER … SET DEFAULT` → backfill in batches | — |
| `missing-lock-timeout` (PG) | Waiting for its lock, the ALTER queues every later query behind it: a 1 ms DDL causes a minutes-long outage | `SET lock_timeout = '5s'` (and `statement_timeout`) at the top; retry with backoff on timeout | A long timeout "so it doesn't fail" |
| `mysql-no-algorithm` | MySQL silently falls back to a table COPY with locks | `ALGORITHM=INSTANT` or `INPLACE, LOCK=NONE` so it fails instead; COPY on a big table → gh-ost | Trusting the default |
| `update-all` | One transaction over the whole table: long locks, bloat, replica lag | Backfill outside the DDL migration, by key range (`WHERE id > $last ORDER BY id LIMIT 1000`), idempotent, pausing between batches, resumable | `UPDATE t SET …` in the migration |
| `not-atomic` | A failure halfway leaves the schema between versions | `BEGIN/COMMIT` (PG, SQLite — DDL is transactional); MySQL DDL auto-commits, so one DDL per migration. Allow-file it when the runner wraps each file | — |
| `missing-down` | No tested way back | A down that runs (tested up → down → up), or `-- migration-lint: irreversible -- <recovery plan: backup, PITR>`. In the expand phase the rollback is redeploying the previous code | A down that "drops everything" untested |
| `applied-migration-changed` | Environments that ran the old version never run the new one; checksums fail (Flyway, Atlas, Prisma) | Restore the file from the base; write the correction as a **new** migration | `flyway repair`, `liquibase clear-checksums`, `atlas migrate hash`, `prisma migrate resolve`, `alembic stamp`, deleting history rows — only by a person, recorded |
| `out-of-order`, `duplicate-sequence` | Runners skip, reject or double-apply; two heads (Alembic), conflicting leaves (Django) | Renumber/regenerate the **branch's** migration on top of main's; `alembic merge heads`; `makemigrations --merge` | Renumbering main's; "keep both" in the merge |

A migration must also be **self-contained**: it does not import the application's current models,
enums or services (Django: `apps.get_model`; Rails: define a minimal model class inside the migration),
or an old migration breaks as soon as the code changes. And the schema history must match the model:
`makemigrations --check`, `alembic check`, `prisma migrate diff --exit-code`, `drizzle-kit check`.

SQLite cannot alter most column properties: the tool rebuilds the table (create `new_t`, `INSERT … SELECT`,
drop `t`, rename). The linter recognises that pattern and does not report its DROP/RENAME — check that the
`INSERT … SELECT` copies **every** column, or the rebuild drops one silently.

Generated migrations (Prisma, Drizzle, EF Core, Django) are drafts: generate with `--create-only` / without
applying, read the SQL, split or edit it before it reaches main. `prisma db push` / `drizzle-kit push`
never touch a shared database.

### 4. Rehearse on a copy with realistic data

The linter reads text; only the database knows the data. An empty test database proves almost nothing:
NOT NULL, UNIQUE, FK and type changes pass on zero rows and fail on the first real one.

**SQLite** — bundled (Node 22.5+):

```bash
node <skill-dir>/scripts/rehearse-sqlite.mjs app.db db/migrations/0007_due.sql db/migrations/0008_x.sql
node <skill-dir>/scripts/rehearse-sqlite.mjs seed.sql 0007.up.sql --down 0007.down.sql   # up → down → up
```

It works on a temporary copy, reports run/fail, time and per-table row counts, flags tables that lost
rows and orphan foreign keys. Exit 0 / 1 / 2 as the linter.

**PostgreSQL / MySQL** — same engine and major version as production, never SQLite as a stand-in:

1. Restore a recent backup (or an anonymised subset of the largest tables) into a throwaway database:
   `pg_restore -d rehearsal latest.dump` / `createdb -T prod_copy rehearsal`; a seed that holds the cases
   that break DDL — NULLs, duplicates, orphans, the longest values, the max ids.
2. Check out main's last state, migrate, then switch to the branch and apply **only the new migrations**
   (the upgrade path, not a fresh install).
3. Measure duration and locks: `\timing`, and in another session
   `SELECT pid, mode, granted, query FROM pg_locks JOIN pg_stat_activity USING (pid) WHERE relation = 't'::regclass;`
   — anything holding `AccessExclusiveLock` longer than the lock timeout fails the rehearsal.
4. Run main's test suite (N-1 code) against the migrated schema: that is the rolling-deploy check.
5. Run down, then up again, if the migration claims to be reversible.

In CI: the engine as a pinned container, `migrate up → down → up` on an empty and a seeded database, and
the linter (or squawk / Atlas lint / strong_migrations) as a required check.

### 5. Verify and report

- Linter exit code and last line, per file; every `allow` with its reason.
- Rehearsal: where (engine, version, data size), duration, rows before/after, test suite of N-1 code.
- The release plan when the change has several steps: which deploy carries which migration.
- What could not run, said as such ("rehearsal could not run: no copy of production available").

## Limits of the linter

- Regex over statements, not a SQL parser: it reads standard DDL; vendor extensions, `DO` blocks and
  procedural code are not analysed (bodies in `$$…$$` are skipped on purpose).
- "Existing table" means not created earlier in the same file. It does not know table sizes: a warning on
  a ten-row table can be allowed with that reason; on a hundred-million-row table it is an outage.
- It does not see ORM migrations written in Ruby, Python or TypeScript — lint their generated SQL.
- No SQL Server or Oracle rules. MySQL coverage is the ALGORITHM rule plus the generic ones.
- The history check reads migration folders named `migrations/`, `migration/`, `db/migrate/`,
  `alembic/versions/`, `db/changelog(s)/`; Alembic order is a revision graph, so only edits are checked there.
