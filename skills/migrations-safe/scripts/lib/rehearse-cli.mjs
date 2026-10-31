// Command line of rehearse-sqlite: arguments and exit code (0 clean, 1 problems, 2 could not run).
import { RehearsalUsageError, rehearse } from './rehearse.mjs';

export const USAGE = `usage: rehearse-sqlite.mjs <database.sqlite | seed.sql> <migration.sql>... [--down [<down.sql>...]] [options]

  <database | seed>   a SQLite file (copied, never written) or a .sql seed loaded into an empty database
  --down [files]      after the ups run the downs in reverse, then the ups again; with no files, the down
                      sections of the migrations themselves (goose, dbmate, sql-migrate)
  --runner <id>       how the runner executes files (transaction wrapping, foreign_keys); default: detected
  --foreign-keys on|off   override the runner's PRAGMA foreign_keys
  --allow-loss <list>     table or table.column names whose loss is intended, comma separated
  -h, --help

exit: 0 all ran and nothing was lost, 1 a migration failed or lost data, 2 could not run
needs Node 22.13+ (node:sqlite)`;

const parseArgs = (argv) => {
  const opts = { source: null, ups: [], downs: null, runner: null, foreignKeys: null, allowLoss: [], help: false };
  let mode = 'up';
  const value = (i, flag) => {
    if (i + 1 >= argv.length) throw new RehearsalUsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--down') { mode = 'down'; opts.downs = []; }
    else if (a === '--runner') opts.runner = value(i++, a);
    else if (a === '--foreign-keys') {
      opts.foreignKeys = value(i++, a);
      if (!['on', 'off'].includes(opts.foreignKeys)) throw new RehearsalUsageError('--foreign-keys takes on or off');
    } else if (a === '--allow-loss') opts.allowLoss = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--')) throw new RehearsalUsageError(`unknown option ${a}`);
    else if (opts.source === null) opts.source = a;
    else if (mode === 'down') opts.downs.push(a);
    else opts.ups.push(a);
  }
  if (opts.downs && !opts.downs.length) opts.downs = 'sections';
  return opts;
};

export const runRehearseCli = async (argv, { out = (s) => console.log(s), err = (s) => console.error(s) } = {}) => {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { out(USAGE); return 0; }
    return await rehearse(opts, out);
  } catch (e) {
    err(`could not run: ${e instanceof RehearsalUsageError ? e.message : (e.stack ?? e.message)}`);
    return 2;
  }
};
