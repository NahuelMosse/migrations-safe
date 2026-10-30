#!/usr/bin/env node
// rehearse-sqlite.mjs <database.sqlite | seed.sql> <migration.sql>... [--down <down.sql>...]
//
// Applies migrations to a throwaway copy of a SQLite database that holds realistic data, and reports
// for each one: whether it ran, how long it took, and the row count of every table before and after.
// A table that lost rows, or vanished, is reported; so is a migration that failed. With --down, the
// downs run after the ups, then the ups again (up → down → up). The original file is never opened for
// writing. Exit 0 all ran and no rows were lost, 1 a migration failed or rows were lost, 2 could not run.
//
// The first argument can be a `.sql` seed instead of a database: it is loaded into an empty copy first.
// Needs Node 22.5+ (node:sqlite). For PostgreSQL and MySQL the same rehearsal is a restored dump; see SKILL.md.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DOWN_MARKER = /^\s*--\s*(\+goose\s+down|\+migrate\s+down|migrate:down)\b.*$/im;
const upPart = (sql) => { const m = sql.match(DOWN_MARKER); return m ? sql.slice(0, m.index) : sql; };

const main = async (argv) => {
  const split = argv.indexOf('--down');
  const ups = (split === -1 ? argv : argv.slice(0, split)).slice(1);
  const downs = split === -1 ? [] : argv.slice(split + 1);
  const source = argv[0];
  if (!source || !ups.length) throw new Error('usage: rehearse-sqlite.mjs <database.sqlite|seed.sql> <migration.sql>... [--down <down.sql>...]');
  let DatabaseSync;
  process.removeAllListeners('warning'); // node:sqlite prints an ExperimentalWarning on import
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { throw new Error('node:sqlite is not available (Node 22.5+ needed)'); }

  const dir = mkdtempSync(join(tmpdir(), 'rehearse-'));
  const copy = join(dir, 'copy.sqlite');
  let db;
  try {
    if (/\.sql$/i.test(source)) { db = new DatabaseSync(copy); db.exec(readFileSync(source, 'utf8')); }
    else { copyFileSync(source, copy); db = new DatabaseSync(copy); }
    const counts = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
      .map(({ name }) => [name, db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n]));
    let failed = 0;
    const run = (file, kind) => {
      const before = counts();
      const t0 = performance.now();
      try {
        db.exec(kind === 'up' ? upPart(readFileSync(file, 'utf8')) : readFileSync(file, 'utf8'));
      } catch (e) {
        failed++;
        try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
        console.log(`FAILED  ${kind.padEnd(4)} ${file}: ${e.message}`);
        return;
      }
      const ms = (performance.now() - t0).toFixed(1);
      const after = counts();
      const lost = Object.entries(before).filter(([t, n]) => kind === 'up' && (after[t] === undefined ? n > 0 : after[t] < n))
        .map(([t, n]) => `${t} ${n}→${after[t] ?? 'dropped'}`);
      if (lost.length) failed++;
      const changes = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t] ?? '-'}→${after[t] ?? '-'}`);
      console.log(`${lost.length ? 'LOST   ' : 'ran    '} ${kind.padEnd(4)} ${file} in ${ms} ms${changes.length ? ` · rows: ${changes.join(', ')}` : ''}${lost.length ? ` · rows lost: ${lost.join(', ')}` : ''}`);
    };
    ups.forEach((f) => run(f, 'up'));
    if (downs.length && !failed) {
      [...downs].reverse().forEach((f) => run(f, 'down'));
      if (!failed) ups.forEach((f) => run(f, 'up'));
    }
    const check = db.prepare('PRAGMA foreign_key_check').all();
    if (check.length) { failed++; console.log(`FAILED  foreign_key_check: ${check.length} orphan row(s), first in ${check[0].table}`); }
    console.log(`${ups.length} up(s)${downs.length ? `, ${downs.length} down(s)` : ''} on a copy of ${source}: ${failed ? `${failed} problem(s)` : 'all ran, no rows lost'}`);
    return failed ? 1 : 0;
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`could not run: ${e.message}`); process.exitCode = 2; });
