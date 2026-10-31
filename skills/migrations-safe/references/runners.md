# Runners and dialects

Load this when the project uses one of these tools, or when the linter's runner or dialect guess looks
wrong. `--runner <id>` and `--dialect postgres|sqlite|mysql|mssql|oracle|db2` override detection.

Detection order: `--runner`; the project's config files (searched upwards from the file to the repository
root, including a `.sqlproj`, a `*ModelSnapshot.cs` and a `.csproj` that references `dbup-`); markers inside the
file (`-- +goose`, `-- migrate:up`, `__EFMigrationsHistory`, `tmp_ms_xx_`); the file name; otherwise `raw`.
Dialect: `--dialect`; a `-- migration-lint: dialect sqlite` line; `migration_lock.toml` (provider `sqlserver`
too) or the Drizzle config; the syntax; the engine the project's files name; otherwise PostgreSQL, and then the
run prints `dialect assumed to be PostgreSQL` with how to change it. The project's files are read in the nearest
directory upwards that holds one, most specific first: the jdbc URL in `flyway.conf` / `flyway.toml` /
`liquibase.properties`, a Liquibase changelog `dbms`, an SSDT `.sqlproj` (SQL Server); the EF Core / DbUp provider
package in a `.csproj` and the connection strings in `appsettings*.json`; the `image:` of a compose file
(`mcr.microsoft.com/mssql/server`, `gvenzl/oracle-*`, `container-registry.oracle.com/database`,
`icr.io/db2_community/db2`, `postgres`, `mysql`, `mariadb`). If a more specific source disagrees with a less
specific one the first wins and the run warns, naming the other; if sources of the same rank disagree (a compose
file with SQL Server and Oracle) nothing is chosen, PostgreSQL is assumed and the warning lists them: pass
`--dialect`. Syntax markers beat an inferred engine. Syntax markers, strongest first: `--#SET
TERMINATOR`, `ADMIN_CMD`, `SYSPROC.`, `SET CURRENT LOCK TIMEOUT` mean Db2; `GO` alone on a line, a `[bracketed]`
identifier, `sp_rename`, `nvarchar` mean SQL Server; `/` alone on a line, `VARCHAR2`, `EXECUTE IMMEDIATE`,
`FROM dual` mean Oracle; backticks, `AUTO_INCREMENT`, `MODIFY COLUMN` mean MySQL; `PRAGMA`, `AUTOINCREMENT` mean
SQLite. `GENERATED ... IDENTITY` and `int[]` say nothing: PostgreSQL has both.

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
| `rails` | `config/application.rb`, `db/migrate/*.rb` | SQL logged while `rails db:migrate` runs on a scratch database, piped to `-` | yes | yes | lenient |
| `efcore` | `*ModelSnapshot.cs`, `__EFMigrationsHistory` in the SQL | `dotnet ef migrations script --idempotent` piped to `-` | yes | no (the script shows its own) | strict |
| `dbup` | a `.csproj` with `dbup-*` | the script files | no | no | lenient |
| `sqlpackage` | a `.sqlproj`, `tmp_ms_xx_`, `:setvar DatabaseName` | `sqlpackage /Action:Script` piped to `-` | no | no (the script shows its own) | graph |
| `raw` | nothing found | any `.sql` | yes | no | strict |

What a profile changes in the findings:

- `missing-down` only for runners with downs.
- Oracle commits every DDL implicitly, so no runner wraps a file on Oracle, whatever its profile says; Django and
  Alembic do not wrap on MySQL either.
- A batch separator the runner does not understand is `unsupported-separator`: Flyway splits on `GO` (SQL
  Server) and `/` (Oracle); Liquibase on those and on `endDelimiter:`; DbUp, `sqlpackage` and EF Core scripts
  use `GO`; goose, dbmate, golang-migrate, Atlas, Prisma and Drizzle send the file to the driver whole (read from
  each project's documentation, not run here). `raw` is applied by something this tool cannot see (sqlcmd,
  SQL*Plus, the Db2 CLP) and reads all of them. Liquibase formatted SQL also reads `runInTransaction:false`.
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

- On stdin the generated SQL shows what the runner does: a `BEGIN`/`COMMIT` in it means it is wrapped, its
  absence means it is not. No `missing-down` is reported for stdin, and empty stdin is exit 2.
- Flyway runs a script outside a transaction when every statement in it is `CONCURRENTLY`, or when a
  `V2__x.sql.conf` next to it has `executeInTransaction=false`; the linter reads both.
- **Rails**: `strong_migrations` sees the DSL and is the primary check. To lint the SQL, run
  `rails db:migrate` on a scratch database with the statements logged (`ActiveRecord::Base.logger =
  Logger.new($stdout)` in an initializer for the run) and pipe the `CREATE`/`ALTER` lines in. `rails
  db:migrate:status` only lists versions; it prints no SQL.
- **Knex**: no dry-run SQL. Run `knex migrate:latest` on a scratch database with `DEBUG=knex:query`, or
  write the risky steps as `knex.raw` SQL and lint that.
- **EF Core and SqlPackage**: `dotnet ef migrations script --idempotent` and `sqlpackage /Action:Script` produce
  T-SQL; pipe it to `migration-lint.mjs -`. The `IF NOT EXISTS (...) BEGIN ... END` guard and `EXEC(N'...')`
  wrapper EF writes are looked through; a DACPAC table rebuild (`tmp_ms_xx_<table>`, `sp_rename`) is checked for
  columns the new table drops.
- **Prisma, Drizzle, EF Core, Django**: generated migrations are drafts. Generate without applying
  (`prisma migrate dev --create-only`, `drizzle-kit generate`), read the SQL, split or edit it before it
  reaches main. `prisma db push` and `drizzle-kit push` never touch a shared database.

## PostgreSQL second opinion

The linter is regex-based and reads standard DDL. For PostgreSQL, run `squawk` as well: it parses with
the real PostgreSQL parser and covers rules this tool does not.
