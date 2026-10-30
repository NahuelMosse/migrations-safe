# Rehearsing a migration

Load this before rehearsing, or when a rehearsal result needs interpreting.

The linter reads text; only the database knows the data. An empty test database proves almost nothing:
NOT NULL, UNIQUE, foreign keys and type changes pass on zero rows and fail on the first real one.

## SQLite (bundled)

```bash
node "${CLAUDE_SKILL_DIR}/scripts/rehearse-sqlite.mjs" app.db db/migrations/0007_due.sql db/migrations/0008_x.sql
node "${CLAUDE_SKILL_DIR}/scripts/rehearse-sqlite.mjs" seed.sql 0007.up.sql --down 0007.down.sql   # up, down, up
node "${CLAUDE_SKILL_DIR}/scripts/rehearse-sqlite.mjs" seed.sql 0007.sql --down                     # down sections of a goose/dbmate file
```

Needs Node 22.13 or newer (`node:sqlite`). The database is copied with SQLite's own `VACUUM INTO`, so a
database in WAL mode is copied with its latest writes and the original is never opened for writing. A
`.sql` argument is loaded as a seed into an empty database.

For every migration it prints whether it ran, the time, and for **every table** its rows and the columns
that were added, dropped, retyped or emptied. It fails (exit 1) when:

- a migration does not run (the rest are then skipped, not run on top of a half-applied state);
- a table lost rows or was dropped with rows in it;
- a column that held values was dropped (a column renamed with its values intact is reported as
  `renamed to ...?`, not as a loss) or its non-NULL count went down;
- the migration created foreign-key orphans. Orphans already in the data do not count.

`--allow-loss tasks.priority,audit` marks intended losses (a contract step after approval).

The runner is detected from the first migration (`--runner` overrides): files are wrapped in a
transaction when the runner does that, and `PRAGMA foreign_keys` is set the way the runner sets it
(`--foreign-keys on|off` overrides). So a rebuild that relies on `PRAGMA foreign_keys=OFF` inside a
wrapped file shows the cascade deletes it would cause in production.

Exit 0 all ran and nothing was lost, 1 a migration failed or lost data, 2 could not run.

## PostgreSQL and MySQL

Same engine and major version as production, never SQLite as a stand-in.

1. Restore a recent backup, or an anonymised subset of the largest tables, into a throwaway database
   (`pg_restore -d rehearsal latest.dump`, `createdb -T prod_copy rehearsal`). The data must hold the
   cases that break DDL: NULLs, duplicates, orphans, the longest values, the maximum ids.
2. Check out main's last state and migrate, then switch to the branch and apply only the new migrations
   (the upgrade path, not a fresh install).
3. Measure duration and locks: `\timing`, and in another session
   `SELECT pid, mode, granted, query FROM pg_locks JOIN pg_stat_activity USING (pid) WHERE relation = 't'::regclass;`.
   Anything holding `AccessExclusiveLock` longer than the lock timeout fails the rehearsal.
4. Run main's test suite (the N-1 code) against the migrated schema: that is the rolling-deploy check.
5. Run the down, then up again, if the migration claims to be reversible.

In CI: the engine as a pinned container, `migrate up`, `down`, `up` on an empty and on a seeded database,
and the linter (or squawk, Atlas lint, strong_migrations) as a required check.
