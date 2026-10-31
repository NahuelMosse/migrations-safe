# migrations-safe

An npm package with a CLI and a GitHub Action, and a Claude Code skill that runs the same CLI, for writing and
reviewing database migrations that do not lose data, break the code already running, or lock a busy table.

- `migration-lint`: static checks over SQL migrations (PostgreSQL, SQLite, MySQL, SQL Server, Oracle, Db2 LUW), plus git history checks
  for applied migrations that were edited, renamed, deleted, out of order or duplicated.
- `rehearse`: applies migrations to a copy of a SQLite database, or to a throwaway PostgreSQL, MySQL or
  MariaDB Docker container seeded from a `.sql` file or a dump, and reports rows and columns per table, lost
  values, duration and the write-blocking locks each migration held (`rehearse-sqlite` is the same command
  under its older name).

Zero runtime dependencies. Node 22.13 or newer.

## Install

```bash
npm i -D migrations-safe
```

## Usage

```bash
npx migration-lint db/migrations/            # lint files or folders
npx migration-lint --history                 # new migrations in this branch + git checks
python manage.py sqlmigrate shop 0042 | npx migration-lint - --runner django
npx rehearse app.db db/migrations/0007_due.sql
npx rehearse --engine postgres:16 seed.sql db/migrations/0007_due.sql --down
npx rehearse --engine mysql:8.4 --dump prod-subset.sql.gz 0007.sql --lock-budget 1s
```

Lint options: `--runner`, `--dialect`, `--server-version` (`--mysql-version`), `--edition`, `--fail-on warning|error|<rule>,...`,
`--format text|json|sarif|github`, `--base`, `--repo`, `--schema`; `--help` lists them. Rehearsal options:
`--engine`, `--edition`, `--dump`, `--down`, `--runner`, `--lock-budget`, `--keep`, `--disk`, `--allow-loss`. Exit codes: 0 nothing at the failure level, 1 findings,
2 could not run (never a pass: 0 files linted, a shallow clone, bad arguments, a crash).

## Support matrix

| Runner | Detected from | Downs | File wrapped in a transaction | Order |
|---|---|---|---|---|
| Prisma | `prisma/schema.prisma`, `migration_lock.toml` | no | implicit, multi-statement | strict |
| Drizzle | `drizzle.config.*`, `meta/_journal.json` | no | yes | strict |
| Flyway | `flyway.conf`, `V1__x.sql` | no | yes | strict |
| Liquibase | `liquibase.properties`, master changelog | yes | yes | graph |
| goose | `-- +goose` | yes | yes | strict |
| dbmate | `-- migrate:up` | yes | yes | lenient |
| golang-migrate | `x.up.sql` / `x.down.sql` | yes | implicit, multi-statement | strict |
| Atlas | `atlas.hcl`, `atlas.sum` | no | yes | strict |
| Alembic, Django, Knex | `alembic.ini`, `manage.py`, `knexfile.*` | yes | yes | graph / graph / strict |
| Rails | `config/application.rb`, `db/migrate/*.rb` | yes | yes | lenient |
| plain SQL | nothing | yes | no | strict |

Alembic, Django, Knex and Rails generate SQL at run time: pipe it in with `-`.

| Dialect | Lint | Rehearsal |
|---|---|---|
| PostgreSQL | all rules (locks, `CONCURRENTLY`, `NOT VALID`, defaults, transactions) | Docker `--engine postgres:<tag>`: duration, `pg_locks`, row and column diff, up-down-up |
| MySQL 5.7, 8.0, 8.4 | `mysql-*` rules per server version (`--mysql-version`): `ALGORITHM` support, metadata-lock timeout, foreign keys, FULLTEXT/SPATIAL, primary keys, charset, ENUM, rebuilds, instant row versions; gh-ost / pt-online-schema-change advice | Docker `--engine mysql:<tag>`: duration, `performance_schema.metadata_locks`, diff, up-down-up |
| MariaDB 10.3+ | same rules with MariaDB's instant-DDL versions (`--mysql-version mariadb-10.6`) | Docker `--engine mariadb:<tag>`: metadata locks through the `metadata_lock_info` plugin |
| SQL Server 2016+ | `mssql-*` rules by version and edition (`--server-version`, `--edition standard\|enterprise\|azure`): online DDL, NOT NULL defaults, `LOCK_TIMEOUT`, constraints, `sp_rename`; `GO` batches, EF Core and DACPAC scripts | Docker `--engine mssql:<tag>`: Express, Standard Developer or Developer by edition, `sys.dm_tran_locks` |
| Oracle 11g+ | `oracle-*` rules (`--edition se2\|ee`): defaults before 12.1, `DDL_LOCK_TIMEOUT`, implicit commits, `ONLINE`, `NOVALIDATE`, missing `/` | Docker `--engine oracle:<tag>` (Free; SE2 is not emulated), `v$lock` |
| Db2 LUW 10.5+ | `db2-*` rules: REORG-pending after `DROP COLUMN`/`SET NOT NULL`/`SET DATA TYPE`, REORG limit, constraint checks, lock timeout | Docker `--engine db2:<tag>`, `MON_GET_LOCKS`, `REORG_PENDING` check (scheduled in CI) |
| SQLite | generic rules, table rebuild checks | bundled `node:sqlite`, no Docker |

The linter is regex-based; for PostgreSQL also run `squawk`. Server-engine rehearsals need the `docker` CLI and
reach the database only through `docker exec` (the container has no network, except Oracle and Db2: an `--internal` Docker network with no outside access, which nothing else joins); it is removed when the run ends,
also on failure, Ctrl+C or SIGTERM. A run killed without a chance to clean up (TerminateProcess, a CI cancel)
leaves its container, and the next run on the same system (label `msafe-owner`) removes containers whose process is gone.

## CI

`--history` compares the branch with its base and needs the full history, so the checkout must not be shallow:

```yaml
name: migrations
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npx --no-install migration-lint --history --base origin/${{ github.base_ref }} --format github
```

With `fetch-depth: 1` the history checks exit 2 and say so. For a push to main, compare with the commit before
the push (`fetch-depth: 0` keeps it available):

```yaml
      - run: npx --no-install migration-lint --history --base ${{ github.event.before }} --format github
```

### GitHub Action, for projects without Node tooling

```yaml
name: migrations
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # --history needs the full history
      - uses: NahuelMosse/migrations-safe@v1.2.1
```

Inputs: `args` (arguments for `migration-lint`; default `--history --base origin/${{ github.base_ref }} --format github`)
and `node-version` (default `24`). `args` is split on spaces, so a path with a space cannot be passed.

A rehearsal job on a Linux runner (Docker is installed) with the engine pinned to production's version:

```yaml
  rehearse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm ci
      - run: npx --no-install rehearse --engine postgres:16 db/seed.sql db/migrations/*.up.sql --down
```

## Claude Code skill

The skill tells the agent when to run these commands and how to fix each finding (expand, migrate, contract). It runs
the same CLI from the skill directory, and prefers the project's `devDependencies` copy when there is one.

```bash
claude plugin marketplace add NahuelMosse/migrations-safe
claude plugin install migrations-safe@migrations-safe
```

Pin a release by adding the tag to the marketplace source, and update when you choose to:

```bash
claude plugin marketplace add NahuelMosse/migrations-safe#v1.2.1
claude plugin marketplace update migrations-safe
claude plugin update migrations-safe@migrations-safe
```

To vendor only the skill directory: `npx skills add NahuelMosse/migrations-safe`.

## Development

```bash
npm test
node skills/migrations-safe/scripts/migration-lint.mjs test/fixtures/good --strict
```

The Docker rehearsal tests start containers (`postgres:16`, `mysql:8.4` by default; `MSAFE_DOCKER_ENGINES=postgres:17,mariadb:11`
changes them; `mssql:2022-CU14-ubuntu-22.04`, `oracle:23.5-slim-faststart` and `db2:11.5.9.0` run the other engines, which take minutes to start). Without Docker they are reported as `skipped: docker not available`; `MSAFE_REQUIRE_DOCKER=1` turns
that into a failure and `MSAFE_DOCKER_TESTS=0` skips them on purpose.

Trigger evals live in `evals/` (run them with `claude plugin eval . --scaffold --allow-tools Bash`: four cases
seed their workspace with a `fixture.sh`, and every case lists `Skill` in `allowed_tools` so the skill can fire).

Layout: `skills/migrations-safe/` (SKILL.md, `scripts/`, `scripts/lib/`, `references/`), `action.yml`, `evals/`,
`test/` (with `fixtures/`). License MIT.
