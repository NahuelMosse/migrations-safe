# Runners and dialects

Load this when the project uses one of these tools, or when the linter's runner or dialect guess looks
wrong. `--runner <id>` and `--dialect postgres|sqlite|mysql` override detection.

Detection order: `--runner`; the project's config files (searched upwards from the file to the repository
root); markers inside the file (`-- +goose`, `-- migrate:up`); the file name; otherwise `raw`.
Dialect: `--dialect`; a `-- migration-lint: dialect sqlite` line; `migration_lock.toml` or the Drizzle
config; the syntax (backticks, `AUTO_INCREMENT`, `MODIFY COLUMN` mean MySQL; `PRAGMA`, `AUTOINCREMENT`
mean SQLite); otherwise PostgreSQL.

| Runner | Detected by | Lint input | Downs | Wraps each file in a transaction | Order |
|---|---|---|---|---|---|
| `prisma` | `prisma/schema.prisma`, `migration_lock.toml` | `prisma/migrations/*/migration.sql` | no | one statement or implicit multi-statement transaction | strict |
| `drizzle` | `drizzle.config.*`, `drizzle/meta/_journal.json` | `drizzle/*.sql` | no | yes | strict |
| `flyway` | `flyway.conf`, `V1__x.sql` names | `V*__*.sql`; `R__*.sql` repeatable | no (Community) | yes (`executeInTransaction=false` opts out) | strict; `V1` equals `V1_0` |
| `liquibase` | `liquibase.properties`, master changelog | formatted SQL changelogs | yes (rollback) | per changeset | graph (changelog order) |
| `goose` | `-- +goose` markers | one file, Up and Down sections | yes | yes (`-- +goose NO TRANSACTION` opts out) | strict |
| `dbmate` | `-- migrate:up` markers | one file, up and down sections | yes | yes (`transaction:false` opts out) | lenient |
| `golang-migrate` | `x.up.sql` / `x.down.sql` names | the pair of files | yes | implicit when the file has several statements | strict |
| `atlas` | `atlas.hcl`, `atlas.sum` | versioned `.sql` files | no | yes (`-- atlas:txmode none`) | strict |
| `alembic` | `alembic.ini` | `alembic upgrade A:B --sql` piped to `-` | yes | yes | graph |
| `django` | `manage.py` | `python manage.py sqlmigrate <app> <n>` piped to `-` | yes | yes (`atomic`) | graph |
| `knex` | `knexfile.*` | statements logged while it runs on a scratch database, piped to `-` | yes | yes | strict |
| `raw` | nothing found | any `.sql` | yes | no | strict |

What a profile changes in the findings:

- `missing-down` only for runners with downs.
- `not-atomic` and `transaction-conflict` depend on whether the runner already wraps the file; a
  `CONCURRENTLY` statement in a wrapped file is `concurrently-in-transaction` even with no `BEGIN`.
- `--history` ignores manifests (`_journal.json`, snapshots, `atlas.sum`, `migration_lock.toml`, master
  changelogs, Flyway `R__` files), treats `out-of-order` as a warning for lenient runners and skips it for
  graph runners.
- The rehearsal wraps each file the way the runner does and uses its `PRAGMA foreign_keys` setting.

## Runners that generate their SQL

The linter reads SQL. For Alembic, Django, Knex, Rails and similar tools, produce the SQL for the
migration and pipe it in:

```bash
python manage.py sqlmigrate shop 0042 | node "${CLAUDE_SKILL_DIR}/scripts/migration-lint.mjs" - --runner django
alembic upgrade head --sql | node "${CLAUDE_SKILL_DIR}/scripts/migration-lint.mjs" - --runner alembic
```

- **Rails**: `strong_migrations` sees the DSL and is the primary check. To lint the SQL, run
  `rails db:migrate` on a scratch database with the statements logged (`ActiveRecord::Base.logger =
  Logger.new($stdout)` in an initializer for the run) and pipe the `CREATE`/`ALTER` lines in. `rails
  db:migrate:status` only lists versions; it prints no SQL.
- **Knex**: no dry-run SQL. Run `knex migrate:latest` on a scratch database with `DEBUG=knex:query`, or
  write the risky steps as `knex.raw` SQL and lint that.
- **Prisma, Drizzle, EF Core, Django**: generated migrations are drafts. Generate without applying
  (`prisma migrate dev --create-only`, `drizzle-kit generate`), read the SQL, split or edit it before it
  reaches main. `prisma db push` and `drizzle-kit push` never touch a shared database.

## PostgreSQL second opinion

The linter is regex-based and reads standard DDL. For PostgreSQL, run `squawk` as well: it parses with
the real PostgreSQL parser and covers rules this tool does not.
