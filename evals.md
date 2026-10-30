# Evals for migrations-safe

## Should trigger

1. **"Rename `users.fullname` to `display_name`. Write the migration."**
   Expected: no single `RENAME COLUMN`. Proposes expand–contract across releases (add column, write both,
   backfill in batches, switch reads, drop later), writes only the expand migration now with its down, and
   lints it to exit 0.

2. **"Add a required `currency` column to `orders` (it has 40M rows, Postgres 15)."**
   Expected: nullable column (or constant default) → batched, idempotent backfill outside the migration →
   `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL`; `lock_timeout` set. Does not use a fake default to
   pass. Linter run on each file, exit code reported.

3. **"Review this Prisma migration before I merge" (a `migration.sql` with DROP COLUMN and CREATE INDEX).**
   Expected: runs `migration-lint.mjs` on it, reports `drop-column` (error: contract step, backup,
   approval) and `index-without-concurrently`, explains the fix for each, and checks whether the dropped
   column is still read by the code.

4. **"CI says checksum mismatch for V12 after I fixed a typo in it. How do I make Flyway happy?"**
   Expected: restore V12 from main, put the correction in a new `V<next>__…` migration; explains that
   `flyway repair` is a person's recorded decision, not the fix. Runs `--history` to confirm.

5. **"After merging main my branch's migration 0042 collides with another 0042."**
   Expected: renumbers or regenerates the branch's migration on top of main's last (never main's), re-runs
   `--history` against the current tip of main, re-rehearses the upgrade.

6. **"Make sure this SQLite migration won't break the existing data before we ship the app update."**
   Expected: lints it with `--dialect sqlite`, then runs `rehearse-sqlite.mjs` on a copy of a real (or
   seeded) database, reports per-table row counts before/after and up → down → up if a down exists.

## Should not trigger (near misses)

7. **"Design the database schema for a multi-tenant invoicing app."**
   Expected: data modelling from scratch; this skill does not load (it may apply later when the schema
   changes).

8. **"This SELECT on orders takes 4 seconds, which index should I add?"**
   Expected: query tuning. (Only if the user then asks to write the migration that adds the index does
   this skill apply — for `CONCURRENTLY`.)

9. **"Migrate our app from MongoDB to PostgreSQL."**
   Expected: a platform/data migration (ETL, dual writes between products), not schema-migration safety.

10. **"Upgrade our Postgres server from 13 to 16."**
    Expected: a server version upgrade (pg_upgrade, logical replication); the word "migrate" must not
    trigger this skill.
