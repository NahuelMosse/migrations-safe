// Migration runner profiles and dialect detection.
//
// A profile says how a runner treats files, so the rules do not guess:
//   downs     the runner has a notion of a down migration (missing-down only applies then)
//   wraps     each file runs inside a transaction: true, false, or 'multi' (implicit transaction only
//             when the file holds more than one statement)
//   manifests files that change with every migration and are not migrations themselves
//   order     'strict'  an older new migration is skipped or rejected (error)
//             'lenient' an older pending migration is applied anyway (warning)
//             'graph'   order comes from a dependency graph, not from names (not checked)
//   foreignKeys  SQLite foreign_keys setting of the runner's connections
//   generatesSql the migrations are code, the SQL is produced at run time
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PROFILES = {
  prisma: {
    label: 'Prisma Migrate', downs: false, wraps: 'multi', order: 'strict', foreignKeys: 'on', generatesSql: false,
    layout: 'one directory per migration with migration.sql', manifests: [/(^|\/)migration_lock\.toml$/],
    config: ['prisma/schema.prisma', 'prisma.config.ts', 'prisma.config.js', 'migration_lock.toml'],
  },
  drizzle: {
    label: 'Drizzle Kit', downs: false, wraps: true, order: 'strict', foreignKeys: 'on', generatesSql: false,
    layout: 'NNNN_name.sql plus meta/_journal.json', manifests: [/(^|\/)meta\/[^/]+\.json$/],
    config: ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs', 'drizzle.config.json', 'meta/_journal.json'],
  },
  flyway: {
    label: 'Flyway', downs: false, wraps: true, order: 'strict', foreignKeys: 'off', generatesSql: false,
    layout: 'V<version>__name.sql, R__name.sql (repeatable), U<version>__name.sql',
    manifests: [/(^|\/)R__[^/]*$/, /(^|\/)flyway\.(conf|toml)$/],
    config: ['flyway.conf', 'flyway.toml', 'conf/flyway.conf'],
  },
  liquibase: {
    label: 'Liquibase', downs: true, wraps: true, order: 'graph', foreignKeys: 'off', generatesSql: false,
    layout: 'changelog files included from a master changelog', manifests: [/(^|\/)(db\.)?changelog-master\.[^/]+$/, /(^|\/)[^/]*master[^/]*\.(xml|ya?ml|json)$/],
    config: ['liquibase.properties', 'db.changelog-master.xml', 'db.changelog-master.yaml', 'db.changelog-master.yml', 'db.changelog-master.json'],
  },
  goose: {
    label: 'goose', downs: true, wraps: true, order: 'strict', foreignKeys: 'off', generatesSql: false,
    layout: 'one file with -- +goose Up / Down sections', manifests: [], config: [],
  },
  dbmate: {
    label: 'dbmate', downs: true, wraps: true, order: 'lenient', foreignKeys: 'off', generatesSql: false,
    layout: 'one file with -- migrate:up / migrate:down sections', manifests: [], config: [],
  },
  'golang-migrate': {
    label: 'golang-migrate', downs: true, wraps: 'multi', order: 'strict', foreignKeys: 'off', generatesSql: false,
    layout: '<version>_name.up.sql and .down.sql', manifests: [], config: [],
  },
  atlas: {
    label: 'Atlas', downs: false, wraps: true, order: 'strict', foreignKeys: 'off', generatesSql: false,
    layout: 'versioned .sql files plus atlas.sum', manifests: [/(^|\/)atlas\.sum$/, /(^|\/)atlas\.hcl$/],
    config: ['atlas.hcl', 'atlas.sum'],
  },
  alembic: {
    label: 'Alembic', downs: true, wraps: true, order: 'graph', foreignKeys: 'off', generatesSql: true,
    layout: 'Python revisions linked by down_revision', manifests: [], config: ['alembic.ini'],
    hint: 'alembic upgrade <from>:<to> --sql',
  },
  django: {
    label: 'Django', downs: true, wraps: true, order: 'graph', foreignKeys: 'on', generatesSql: true,
    layout: 'Python migrations linked by dependencies', manifests: [], config: ['manage.py'],
    hint: 'python manage.py sqlmigrate <app> <migration>',
  },
  knex: {
    label: 'Knex', downs: true, wraps: true, order: 'strict', foreignKeys: 'off', generatesSql: true,
    layout: 'JS/TS migrations with up and down', manifests: [],
    config: ['knexfile.js', 'knexfile.ts', 'knexfile.cjs', 'knexfile.mjs'],
    hint: 'run knex migrate:latest on a scratch database with DEBUG=knex:query and pipe the statements',
  },
  rails: {
    label: 'Rails', downs: true, wraps: true, order: 'lenient', foreignKeys: 'off', generatesSql: true,
    layout: 'db/migrate/<timestamp>_name.rb', manifests: [/(^|\/)db\/(schema\.rb|structure\.sql)$/], config: ['config/application.rb'],
    hint: 'run rails db:migrate on a scratch database with the SQL logged and pipe the statements',
  },
  raw: {
    label: 'plain SQL files', downs: true, wraps: false, order: 'strict', foreignKeys: 'off', generatesSql: false,
    layout: 'any .sql files, applied in name order by something else', manifests: [], config: [],
  },
};

export const RUNNER_IDS = Object.keys(PROFILES);
export const DIALECTS = ['postgres', 'sqlite', 'mysql', 'mssql', 'oracle', 'db2'];

export const profileOf = (id) => ({ id, ...PROFILES[id] });

const CONFIG_PRIORITY = ['prisma', 'drizzle', 'atlas', 'liquibase', 'flyway', 'alembic', 'knex', 'django', 'rails'];

// The runner a file's own markers point to, or null.
export const runnerFromMarkers = (markers) => {
  if (markers?.liquibase) return { id: 'liquibase', evidence: '--liquibase formatted sql header' };
  if (markers?.goose) return { id: 'goose', evidence: '-- +goose marker' };
  if (markers?.dbmate) return { id: 'dbmate', evidence: '-- migrate: marker' };
  if (markers?.sqlMigrate) return { id: 'goose', evidence: '-- +migrate marker (sql-migrate uses goose-style sections)' };
  return null;
};

// The runner a file name points to, or null.
export const runnerFromName = (fileName) => {
  if (/^(V\d+(?:[._]\d+)*|R)__.+\.sql$/i.test(fileName)) return { id: 'flyway', evidence: `file name ${fileName}` };
  if (/\.(up|down)\.sql$/i.test(fileName)) return { id: 'golang-migrate', evidence: `file name ${fileName}` };
  return null;
};

const startDir = (path) => { try { return statSync(path).isDirectory() ? path : dirname(path); } catch { return dirname(path); } };

// Directories from `start` upwards, stopping after the one that holds `.git` (or at the root).
const ancestors = (start, limit = 8) => {
  const out = [];
  let dir = resolve(start);
  for (let n = 0; n < limit; n++) {
    out.push(dir);
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return out;
};

// Runner of the project that owns `path`: config files first, then the markers inside the file, then
// the file name. `markers` come from parse().
export const detectRunner = (path, { markers = null, fileName = '' } = {}) => {
  const dirs = ancestors(startDir(path));
  for (const id of CONFIG_PRIORITY) {
    for (const dir of dirs) {
      const hit = PROFILES[id].config.find((c) => existsSync(join(dir, c)));
      if (hit) return { id, evidence: `${hit} in ${dir}` };
    }
  }
  return runnerFromMarkers(markers) ?? runnerFromName(fileName) ?? { id: 'raw', evidence: 'no runner config found' };
};

export const wrapsFile = (profile, { noTransaction = false, statements = 0 } = {}) =>
  !noTransaction && (profile.wraps === true || (profile.wraps === 'multi' && statements > 1));

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const PROVIDERS = { postgresql: 'postgres', postgres: 'postgres', pg: 'postgres', sqlite: 'sqlite', mysql: 'mysql', mariadb: 'mysql', turso: 'sqlite', singlestore: 'mysql',
  sqlserver: 'mssql', mssql: 'mssql', oracle: 'oracle', oracledb: 'oracle', db2: 'db2',
};

// Dialect the project declares: Prisma's migration_lock.toml, a Drizzle config.
export const projectDialect = (path) => {
  for (const dir of ancestors(startDir(path))) {
    const lock = read(join(dir, 'migration_lock.toml'));
    const provider = lock.match(/provider\s*=\s*"([\w]+)"/)?.[1]?.toLowerCase();
    if (provider && PROVIDERS[provider]) return { dialect: PROVIDERS[provider], evidence: `migration_lock.toml in ${dir}` };
    for (const cfg of ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs', 'drizzle.config.json']) {
      const m = read(join(dir, cfg)).match(/dialect['"]?\s*[:=]\s*['"]([\w]+)['"]/i);
      if (m && PROVIDERS[m[1].toLowerCase()]) return { dialect: PROVIDERS[m[1].toLowerCase()], evidence: `${cfg} in ${dir}` };
    }
  }
  return null;
};

// Dialect from the syntax of a file; comments are ignored (Prisma writes backticks in its warnings).
// Markers that belong to one product come first, and only markers PostgreSQL does not use: `[x]` must be an
// identifier (PostgreSQL has `int[]` and `a[1]`), and GENERATED ... IDENTITY says nothing about Db2.
export const sniffDialect = (sql) => {
  if (/^\s*--#\s*SET\s+TERMINATOR\b/im.test(sql)) return 'db2';
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const bare = code.replace(/'(?:[^']|'')*'/g, "''");
  if (/\bpragma\b|\bautoincrement\b|\bwithout rowid\b/i.test(code)) return 'sqlite';
  if (/\badmin_cmd\b|\bsysproc\.|\bwlm_set_client_info\b/i.test(bare)) return 'db2';
  if (/^\s*go(?:\s+\d+)?\s*$/im.test(bare) || /(?:^|[\s.(,])\[[A-Za-z_][\w ]*\](?=[\s.,;)=]|$)/.test(bare)
    || /\bsp_rename\b|\bnvarchar\b|\bidentity\s*\(\s*\d|\bgetdate\s*\(|\bset\s+nocount\b|\bwith\s*\(\s*online\s*=/i.test(bare)) return 'mssql';
  if (/^\s*\/\s*$/m.test(bare) || /\bvarchar2\b|\bnvarchar2\b|\bexecute\s+immediate\b|\bfrom\s+dual\b|\bddl_lock_timeout\b|\bdbms_\w+|\bset\s+unused\b|\benable\s+novalidate\b|\bnumber\s*\(\s*\d|\bmodify\s*\(/i.test(bare)) return 'oracle';
  if (/\bengine\s*=|\bauto_increment\b|\bunsigned\b|\bmodify\s+(?:column\s+)?[\w`]|\brename\s+table\b|`\w+`/i.test(code)) return 'mysql';
  return 'postgres';
};

export const fileDialectDirective = (sql) => sql.match(/^\s*--\s*migration-lint:\s*dialect\s+(\w+)/im)?.[1]?.toLowerCase();

// The dialect the rules use for one file: the explicit one, the file's directive, the project's, or its syntax.
export const resolveDialect = (sql, { dialect, projectDialect } = {}) => {
  const requested = dialect ?? fileDialectDirective(sql) ?? projectDialect;
  return DIALECTS.includes(requested) ? requested : sniffDialect(sql);
};
