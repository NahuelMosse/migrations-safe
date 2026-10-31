# migrations-safe

A Claude Code skill, and a standalone CLI, for writing and reviewing database migrations that do not lose
data, break the code already running, or lock a busy table.

- `migration-lint`: static checks over SQL migrations (PostgreSQL, SQLite, MySQL), plus git history checks
  for applied migrations that were edited, renamed, deleted, out of order or duplicated.
- `rehearse-sqlite`: applies migrations to a copy of a SQLite database and reports rows and columns per
  table, lost values and new foreign-key orphans.
- The skill tells the agent when to run them and how to fix each finding (expand, migrate, contract).

Zero runtime dependencies. Node 22.13 or newer.

## Install as a Claude Code plugin

```bash
claude plugin marketplace add NahuelMosse/migrations-safe
claude plugin install migrations-safe@migrations-safe
```

Pin a release by adding the tag to the marketplace source, and update when you choose to:

```bash
claude plugin marketplace add NahuelMosse/migrations-safe#v1.0.0
claude plugin marketplace update migrations-safe
claude plugin update migrations-safe@migrations-safe
```

## Standalone CLI

```bash
node skills/migrations-safe/scripts/migration-lint.mjs db/migrations/            # lint files or folders
node skills/migrations-safe/scripts/migration-lint.mjs --history                 # new migrations in this branch + git checks
python manage.py sqlmigrate shop 0042 | node skills/migrations-safe/scripts/migration-lint.mjs - --runner django
node skills/migrations-safe/scripts/rehearse-sqlite.mjs app.db db/migrations/0007_due.sql
```

Options: `--runner`, `--dialect`, `--fail-on warning|error|<rule>,...`, `--format text|json|sarif|github`,
`--base`, `--repo`, `--schema`; `--help` lists them. Exit codes: 0 nothing at the failure level, 1 findings,
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

Alembic, Django, Knex and Rails generate SQL at run time: pipe it in with `-`. Dialects: PostgreSQL (all rules),
MySQL (`ALGORITHM`, type changes, renames and the generic rules), SQLite (generic rules, table rebuild checks,
rehearsal). The linter is regex-based; for PostgreSQL also run `squawk`.

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
      - run: |
          git clone --depth 1 --branch v1.0.0 https://github.com/NahuelMosse/migrations-safe.git "$RUNNER_TEMP/ms"
          node "$RUNNER_TEMP/ms/skills/migrations-safe/scripts/migration-lint.mjs" --history --base origin/${{ github.base_ref }} --format github
```

With `fetch-depth: 1` the history checks exit 2 and say so. For a push to main, compare with the commit before
the push (`fetch-depth: 0` keeps it available):

```yaml
      - run: node "$RUNNER_TEMP/ms/skills/migrations-safe/scripts/migration-lint.mjs" --history --base ${{ github.event.before }} --format github
```

## Development

```bash
npm test
node skills/migrations-safe/scripts/migration-lint.mjs skills/migrations-safe/fixtures/good --strict
```

Trigger evals live in `evals/` (run them with `claude plugin eval . --scaffold --allow-tools Bash`: four cases
seed their workspace with a `fixture.sh`, and every case lists `Skill` in `allowed_tools` so the skill can fire).

Layout: `skills/migrations-safe/` (SKILL.md, `scripts/`, `scripts/lib/`, `references/`, `fixtures/`), `evals/`,
`test/`. License MIT.
