// The database engine a project uses, read from the files that sit next to its migrations: the migration tool's
// config (Flyway, Liquibase, an SSDT .sqlproj), the .NET project (EF Core provider, connection strings) and
// the compose file that starts the database. Nothing here runs or connects to anything.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const listDir = (dir) => { try { return readdirSync(dir); } catch { return []; } };

const JDBC = { sqlserver: 'mssql', oracle: 'oracle', db2: 'db2', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', sqlite: 'sqlite' };
const DBMS = { mssql: 'mssql', sqlserver: 'mssql', oracle: 'oracle', db2: 'db2', postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', mariadb: 'mysql', sqlite: 'sqlite' };
const uncommented = (text) => text.split(/\r?\n/).filter((l) => !/^\s*[#;]/.test(l)).join('\n');

// Most specific source first: what the migration tool is configured to connect to beats what a .NET project
// references, and that beats what a compose file happens to start.
const TIER_TOOL = 1;
const TIER_APP = 2;
const TIER_COMPOSE = 3;

const jdbcDialects = (text) => [...uncommented(text).matchAll(/jdbc:(\w+):/gi)].map((m) => JDBC[m[1].toLowerCase()]).filter(Boolean);

const COMPOSE = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'docker-compose.override.yml', 'docker-compose.override.yaml'];
const IMAGES = [
  ['mssql', /^(?:mcr\.microsoft\.com\/(?:mssql\/server|azure-sql-edge)|mssql\/server)\b/i],
  ['oracle', /^(?:(?:docker\.io\/)?gvenzl\/oracle-|container-registry\.oracle\.com\/database\/|oracle\/database\b|(?:docker\.io\/)?wnameless\/oracle)/i],
  ['db2', /^(?:icr\.io\/db2_community\/db2|(?:docker\.io\/)?ibmcom\/db2)\b/i],
  ['postgres', /^(?:docker\.io\/)?(?:library\/)?(?:postgres|postgis\/postgis|bitnami\/postgresql|supabase\/postgres|timescale\/timescaledb)\b/i],
  ['mysql', /^(?:docker\.io\/)?(?:library\/)?(?:mysql|mariadb|bitnami\/mysql|bitnami\/mariadb|percona)\b/i],
];
const imageDialect = (ref) => IMAGES.find(([, re]) => re.test(ref))?.[0];

const EF = [
  ['mssql', /Microsoft\.EntityFrameworkCore\.SqlServer|dbup-sqlserver|Microsoft\.Data\.SqlClient|System\.Data\.SqlClient/i],
  ['oracle', /Oracle\.EntityFrameworkCore|Oracle\.ManagedDataAccess|dbup-oracle/i],
  ['db2', /IBM\.EntityFrameworkCore|IBM\.Data\.Db2|Net5\.IBM\.Data\.Db2/i],
  ['postgres', /Npgsql|dbup-postgresql/i],
  ['mysql', /Pomelo\.EntityFrameworkCore\.MySql|MySql\.EntityFrameworkCore|MySqlConnector|dbup-mysql/i],
  ['sqlite', /Microsoft\.EntityFrameworkCore\.Sqlite|Microsoft\.Data\.Sqlite|dbup-sqlite/i],
];

// A .NET connection string says which engine through the keys it uses.
const connectionDialect = (cs) => {
  if (/\(\s*DESCRIPTION\s*=|Data Source\s*=[^;]*(?::1521\b|\/\/)|Data Source\s*=\s*[\w.-]+\/\w+\s*(?:;|$)/i.test(cs)) return 'oracle';
  if (/\bDB2\b|Server\s*=[^;]*:50000\b/i.test(cs)) return 'db2';
  if (/\bHost\s*=|\bPort\s*=\s*5432\b/i.test(cs)) return 'postgres';
  if (/\bUid\s*=|\bPort\s*=\s*3306\b|\bSslMode\s*=/i.test(cs)) return 'mysql';
  if (/Initial Catalog|TrustServerCertificate|Trusted_Connection|Integrated Security|Server\s*=[^;]*;\s*Database\s*=|Data Source\s*=[^;]*(?:\\SQLEXPRESS|\(localdb\)|,1433\b)/i.test(cs)) return 'mssql';
  return null;
};

const hintsIn = (dir) => {
  const hints = [];
  const add = (dialect, tier, from) => { if (dialect) hints.push({ dialect, tier, from }); };
  const names = listDir(dir);

  for (const f of ['flyway.conf', 'flyway.toml', join('conf', 'flyway.conf'), 'liquibase.properties'])
    for (const d of jdbcDialects(read(join(dir, f)))) add(d, TIER_TOOL, f.replace('\\', '/'));
  for (const f of names.filter((n) => /^(?:db\.changelog.*|changelog.*)\.(?:xml|ya?ml|json|sql)$/i.test(n))) {
    const text = read(join(dir, f));
    const m = text.match(/dbms\s*[=:]\s*["']?(\w+)/i) ?? text.match(/^--\s*liquibase formatted sql[\s\S]*?\bdbms:(\w+)/im);
    if (m) add(DBMS[m[1].toLowerCase()], TIER_TOOL, f);
  }
  for (const f of names.filter((n) => /\.sqlproj$/i.test(n))) add('mssql', TIER_TOOL, f);

  for (const f of names.filter((n) => /\.(?:cs|fs|vb)proj$/i.test(n))) {
    const text = read(join(dir, f));
    for (const [d, re] of EF) if (re.test(text)) add(d, TIER_APP, f);
  }
  for (const f of names.filter((n) => /^appsettings(?:\.[\w-]+)?\.json$/i.test(n))) {
    for (const m of read(join(dir, f)).matchAll(/"([^"\n]*=[^"\n]*)"/g)) add(connectionDialect(m[1]), TIER_APP, f);
  }

  for (const f of COMPOSE)
    for (const m of read(join(dir, f)).matchAll(/^\s*(?:-\s*)?image:\s*["']?([^\s"'#]+)/gim)) add(imageDialect(m[1]), TIER_COMPOSE, f);
  return hints;
};

// The engine declared in `dir`, or null when it holds no hint. { dialect, evidence, conflict } where `conflict`
// lists what disagrees with the choice. When the most specific sources disagree among themselves nothing is
// chosen (dialect null, `ambiguous` lists them): guessing between two engines is how a PostgreSQL rule set ends
// up applied to SQL Server.
export const hintedDialect = (dir) => {
  const hints = hintsIn(dir);
  if (!hints.length) return null;
  const label = (h) => `${h.dialect} from ${h.from}`;
  const uniq = (list) => [...new Set(list.map(label))];
  const topTier = Math.min(...hints.map((h) => h.tier));
  const top = hints.filter((h) => h.tier === topTier);
  const engines = [...new Set(top.map((h) => h.dialect))];
  if (engines.length > 1) return { dialect: null, evidence: null, ambiguous: uniq(hints), dir };
  const others = hints.filter((h) => h.dialect !== engines[0]);
  return { dialect: engines[0], evidence: `${top[0].from} in ${dir}`, conflict: others.length ? uniq(others) : null, dir };
};
