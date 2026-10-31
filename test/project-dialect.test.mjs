import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { hintedDialect } from '../skills/migrations-safe/scripts/lib/dialect-hints.mjs';
import { decideDialect, projectDialect, sniffDialect } from '../skills/migrations-safe/scripts/lib/runners.mjs';
import { lintCli, put, scratch } from './helpers.mjs';

// Marker-free SQL: every engine accepts it, so only the project can say which rules apply.
const MSSQL_SQL = 'ALTER TABLE orders ADD priority int NOT NULL DEFAULT 0;\n';
const ORACLE_SQL = 'CREATE INDEX ix_orders_note ON orders (note);\n';
const DB2_SQL = 'ALTER TABLE orders DROP COLUMN note;\n';

const lintJson = (dir, extra = []) => {
  const r = lintCli([dir, '--format', 'json', ...extra]);
  const body = JSON.parse(r.out);
  return { ...r, rules: body.findings.map((f) => f.rule), notes: body.notes };
};
const noteMatching = (notes, re) => notes.find((n) => re.test(n));

test('SQL Server is inferred from the jdbc URL of flyway.conf', (t) => {
  const dir = scratch(t);
  put(dir, 'flyway.conf', 'flyway.url=jdbc:sqlserver://localhost:1433;databaseName=shop\n');
  put(dir, 'sql/V1__priority.sql', MSSQL_SQL);
  const r = lintJson(join(dir, 'sql'));
  assert.ok(r.rules.includes('mssql-add-not-null-default'), r.rules.join());
  assert.ok(noteMatching(r.notes, /dialect SQL Server inferred from flyway\.conf/), r.notes.join('\n'));
});

test('Oracle is inferred from the image of a compose file', (t) => {
  const dir = scratch(t);
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: gvenzl/oracle-free:23-slim-faststart\n  cache:\n    image: redis:7\n');
  put(dir, 'db/V1__index.sql', ORACLE_SQL);
  const r = lintJson(join(dir, 'db'));
  assert.ok(r.rules.includes('oracle-index-not-online'), r.rules.join());
  assert.ok(!r.rules.some((id) => /concurrent/.test(id)), `PostgreSQL advice on an Oracle project: ${r.rules.join()}`);
  assert.ok(noteMatching(r.notes, /dialect Oracle inferred from docker-compose\.yml/), r.notes.join('\n'));
});

test('Db2 is inferred from the jdbc URL of flyway.toml', (t) => {
  const dir = scratch(t);
  put(dir, 'flyway.toml', '[environments.dev]\nurl = "jdbc:db2://localhost:50000/SHOP"\n');
  put(dir, 'migrations/V1__drop.sql', DB2_SQL);
  const r = lintJson(join(dir, 'migrations'));
  assert.ok(r.rules.includes('db2-reorg-pending'), r.rules.join());
  assert.ok(noteMatching(r.notes, /dialect Db2 inferred from flyway\.toml/), r.notes.join('\n'));
});

test('SQL Server is inferred from an SSDT .sqlproj', (t) => {
  const dir = scratch(t);
  put(dir, 'Shop.Database.sqlproj', '<Project Sdk="Microsoft.Build.Sql/0.1.0"></Project>\n');
  put(dir, 'Scripts/0001_priority.sql', MSSQL_SQL);
  const r = lintJson(join(dir, 'Scripts'));
  assert.ok(r.rules.includes('mssql-add-not-null-default'), r.rules.join());
  assert.ok(noteMatching(r.notes, /inferred from Shop\.Database\.sqlproj/), r.notes.join('\n'));
});

test('an EF Core provider package, a connection string and liquibase.properties name the engine too', (t) => {
  const hint = (name, text) => { const dir = scratch(t); put(dir, name, text); return hintedDialect(dir)?.dialect; };
  assert.equal(hint('App.csproj', '<ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" /></ItemGroup>'), 'mssql');
  assert.equal(hint('App.csproj', '<PackageReference Include="Oracle.EntityFrameworkCore" Version="8.0.0" />'), 'oracle');
  assert.equal(hint('App.csproj', '<PackageReference Include="IBM.EntityFrameworkCore" Version="8.0.0" />'), 'db2');
  assert.equal(hint('App.csproj', '<PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" />'), 'postgres');
  assert.equal(hint('appsettings.json', '{"ConnectionStrings":{"Db":"Server=tcp:db,1433;Database=shop;User Id=sa;TrustServerCertificate=True"}}'), 'mssql');
  assert.equal(hint('appsettings.Development.json', '{"ConnectionStrings":{"Db":"Data Source=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=XEPDB1)));User Id=u;Password=p"}}'), 'oracle');
  assert.equal(hint('appsettings.json', '{"ConnectionStrings":{"Db":"Host=localhost;Database=shop;Username=app"}}'), 'postgres');
  assert.equal(hint('liquibase.properties', 'url=jdbc:oracle:thin:@//h:1521/XEPDB1\n# url=jdbc:postgresql://x/y\n'), 'oracle');
  assert.equal(hint('docker-compose.yml', 'services:\n  db:\n    image: icr.io/db2_community/db2:11.5.9.0\n'), 'db2');
  assert.equal(hint('compose.yaml', 'services:\n  db:\n    image: mcr.microsoft.com/mssql/server:2022-latest\n'), 'mssql');
  assert.equal(hint('compose.yaml', 'services:\n  db:\n    image: mariadb:11\n'), 'mysql');
  assert.equal(hint('flyway.conf', 'flyway.url=jdbc:sqlite:app.db\n'), 'sqlite');
  assert.equal(hint('compose.yaml', 'services:\n  cache:\n    image: redis:7\n'), undefined);
});

test('with nothing to go on the linter assumes PostgreSQL out loud and says how to change it', (t) => {
  const dir = scratch(t);
  put(dir, 'V1__x.sql', DB2_SQL);
  const r = lintJson(dir);
  const note = noteMatching(r.notes, /dialect assumed to be PostgreSQL/);
  assert.ok(note, r.notes.join('\n'));
  assert.match(note, /--dialect/);
  assert.match(note, /-- migration-lint: dialect/);
  const stdin = lintCli(['-', '--format', 'json'], { input: DB2_SQL });
  assert.ok(JSON.parse(stdin.out).notes.some((n) => /dialect assumed to be PostgreSQL/.test(n)));
});

test('no note is printed when the engine was stated: --dialect, the directive, or syntax of one engine', (t) => {
  const dir = scratch(t);
  put(dir, 'V1__a.sql', DB2_SQL);
  assert.ok(!lintJson(dir, ['--dialect', 'db2']).notes.some((n) => /dialect (assumed|inferred)/.test(n)));
  const other = scratch(t);
  put(other, 'V1__b.sql', `-- migration-lint: dialect db2\n${DB2_SQL}`);
  assert.ok(!lintJson(other).notes.some((n) => /dialect (assumed|inferred)/.test(n)));
  const syntax = scratch(t);
  put(syntax, 'V1__c.sql', 'ALTER TABLE [dbo].[orders] ADD [note] nvarchar(10) NULL;\nGO\n');
  assert.ok(!lintJson(syntax).notes.some((n) => /dialect (assumed|inferred)/.test(n)));
});

test('syntax of one engine beats a weaker hint from the project; --dialect beats both', (t) => {
  const dir = scratch(t);
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n');
  put(dir, 'V1__t.sql', 'ALTER TABLE [dbo].[orders] ADD [note] nvarchar(10) NULL;\nGO\n');
  const r = lintJson(dir);
  assert.ok(r.rules.some((id) => id.startsWith('mssql-')), r.rules.join());
  assert.deepEqual(decideDialect('SELECT 1;', { dialect: 'oracle', project: { dialect: 'mssql' } }), { dialect: 'oracle', source: 'option' });
  assert.equal(decideDialect('SELECT 1;', { project: { dialect: 'mssql', declared: true } }).source, 'declared');
});

test('sources that disagree: the most specific one wins and the warning names the others', (t) => {
  const dir = scratch(t);
  put(dir, 'flyway.conf', 'flyway.url=jdbc:sqlserver://localhost;databaseName=shop\n');
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n');
  put(dir, 'V1__priority.sql', MSSQL_SQL);
  const r = lintJson(dir);
  assert.ok(r.rules.includes('mssql-add-not-null-default'), r.rules.join());
  const warning = noteMatching(r.notes, /other project files point to another engine/);
  assert.ok(warning, r.notes.join('\n'));
  assert.match(warning, /postgres from docker-compose\.yml/);
  assert.match(warning, /using SQL Server/);
});

test('sources of the same rank that disagree choose nothing: exit 2 listing the candidates and asking for --dialect or the directive', (t) => {
  const dir = scratch(t);
  put(dir, 'docker-compose.yml', 'services:\n  app-db:\n    image: mcr.microsoft.com/mssql/server:2022-latest\n  legacy:\n    image: gvenzl/oracle-free:23-slim-faststart\n');
  put(dir, 'V1__x.sql', DB2_SQL);
  const info = projectDialect(join(dir, 'V1__x.sql'));
  assert.equal(info.dialect, null);
  assert.equal(info.ambiguous.length, 2);
  const r = lintCli([dir]);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /cannot tell which database engine .*V1__x\.sql is for/);
  assert.match(r.err, /mssql from docker-compose\.yml; oracle from docker-compose\.yml/);
  assert.match(r.err, /--dialect <name> or add `-- migration-lint: dialect <name>`/);
  assert.notEqual(lintCli([dir, '--dialect', 'mssql']).code, 2, '--dialect settles it');
  put(dir, 'V2__x.sql', `-- migration-lint: dialect db2\n${DB2_SQL}`);
  assert.equal(lintCli([join(dir, 'V2__x.sql')]).code, 1, 'a directive settles it');
  // syntax of one engine settles it too: the ambiguous hints are ignored
  const marked = scratch(t);
  put(marked, 'docker-compose.yml', 'services:\n  a:\n    image: postgres:16\n  b:\n    image: mariadb:11\n');
  put(marked, 'V1__x.sql', 'ALTER TABLE [dbo].[orders] ADD [note] nvarchar(10) NULL;\nGO\n');
  assert.ok(lintJson(marked).rules.some((id) => id.startsWith('mssql-')));
});

// The four probes of the review: an engine-specific-looking statement under a project that says otherwise.
test('the migration tool configuration outranks what the syntax looks like, and says so when they disagree', (t) => {
  const probe = (conf, sql, expected) => {
    const dir = scratch(t);
    put(dir, conf[0], conf[1]);
    put(dir, 'V1__x.sql', sql);
    const r = lintJson(dir);
    assert.ok(r.rules.includes(expected), `${sql.slice(0, 40)}: ${r.rules.join()}`);
    return r;
  };
  const oracleConf = ['flyway.conf', 'flyway.url=jdbc:oracle:thin:@//h:1521/XEPDB1\n'];
  const db2Conf = ['flyway.conf', 'flyway.url=jdbc:db2://h:50000/SHOP\n'];
  const modify = probe(oracleConf, 'ALTER TABLE orders MODIFY status NOT NULL;\n', 'oracle-ddl-lock-timeout');
  assert.ok(!modify.notes.some((n) => /syntax suggested/.test(n)), 'the sniffer reads MODIFY ... NOT NULL as Oracle: nothing to disagree about');
  const pragma = probe(oracleConf, "DECLARE\n  e EXCEPTION;\n  PRAGMA EXCEPTION_INIT(e, -1430);\nBEGIN\n  EXECUTE IMMEDIATE 'ALTER TABLE orders ADD (c NUMBER)';\nEXCEPTION WHEN e THEN NULL;\nEND;\n/\n", 'oracle-ddl-lock-timeout');
  assert.ok(!pragma.rules.includes('transaction-conflict'), pragma.rules.join());
  const rename = probe(db2Conf, 'ALTER TABLE orders DROP COLUMN note;\nRENAME TABLE orders TO orders_old;\n', 'db2-reorg-pending');
  assert.match(rename.notes.join('\n'), /the syntax suggested MySQL but the project says Db2 \(flyway\.conf in .*\): using Db2/);
  const nvarchar = probe(db2Conf, 'ALTER TABLE orders ADD COLUMN note NVARCHAR(10);\nALTER TABLE orders DROP COLUMN old;\n', 'db2-reorg-pending');
  assert.match(nvarchar.notes.join('\n'), /the syntax suggested SQL Server but the project says Db2/);
  // explicit choices stay on top of the project
  const dir = scratch(t);
  put(dir, ...db2Conf);
  put(dir, 'V1__x.sql', 'ALTER TABLE t ADD [c] int;\nGO\n');
  assert.ok(lintJson(dir, ['--dialect', 'mssql']).rules.some((id) => id.startsWith('mssql-')));
  put(dir, 'V2__y.sql', `-- migration-lint: dialect mssql\n${MSSQL_SQL}`);
  assert.ok(lintJson(join(dir, 'V2__y.sql')).rules.includes('mssql-add-not-null-default'));
});

test('the sniffer does not read Oracle MODIFY or PL/SQL pragmas as MySQL or SQLite', () => {
  assert.equal(sniffDialect('ALTER TABLE orders MODIFY status NOT NULL;'), 'oracle');
  assert.equal(sniffDialect('ALTER TABLE orders MODIFY status DEFAULT 1;'), 'oracle');
  assert.equal(sniffDialect('ALTER TABLE orders MODIFY status NULL;'), 'oracle');
  assert.equal(sniffDialect('ALTER TABLE orders MODIFY status VARCHAR(20) NOT NULL;'), 'mysql');
  assert.equal(sniffDialect('DECLARE e EXCEPTION; PRAGMA EXCEPTION_INIT(e, -1); BEGIN NULL; END;'), 'oracle');
  assert.equal(sniffDialect('PRAGMA foreign_keys = ON;'), 'sqlite');
});

test('only the values under ConnectionStrings count in appsettings*.json', (t) => {
  const dir = scratch(t);
  put(dir, 'appsettings.json', '{\n  "RabbitMq": { "Url": "host=rabbit;port=5672;username=guest" },\n  // comment\n  "ConnectionStrings": { "Db": "Server=tcp:db,1433;Database=shop;User Id=sa;TrustServerCertificate=True" },\n  "Other": "Host=elsewhere;Database=x"\n}\n');
  assert.equal(hintedDialect(dir).dialect, 'mssql');
  assert.equal(hintedDialect(dir).conflict, null);
  const only = scratch(t);
  put(only, 'appsettings.json', '{ "RabbitMq": { "Url": "host=rabbit;port=5672" }, "Smtp": "Server=mail;Database=x;Uid=u" }');
  assert.equal(hintedDialect(only), null);
});

test('Spring Boot: the config in src/main/resources and the build file at the module root name the engine', (t) => {
  const layout = (files, sql = ORACLE_SQL) => {
    const dir = scratch(t);
    for (const [f, text] of Object.entries(files)) put(dir, f, text);
    put(dir, 'src/main/resources/db/migration/V1__x.sql', sql);
    return projectDialect(join(dir, 'src', 'main', 'resources', 'db', 'migration', 'V1__x.sql'));
  };
  const props = layout({ 'src/main/resources/application.properties': 'spring.datasource.url=jdbc:oracle:thin:@//h:1521/XEPDB1\nspring.datasource.username=app\n' });
  assert.deepEqual([props.dialect, props.strong], ['oracle', true]);
  assert.match(props.evidence, /application\.properties/);
  assert.equal(layout({ 'src/main/resources/application-prod.yml': 'spring:\n  flyway:\n    url: jdbc:sqlserver://h:1433;databaseName=shop\n' }).dialect, 'mssql');
  assert.equal(layout({ 'src/main/resources/application.yml': 'spring:\n  datasource:\n    driver-class-name: com.ibm.db2.jcc.DB2Driver\n' }).dialect, 'db2');
  assert.equal(layout({ 'src/main/resources/config/application.properties': 'spring.datasource.url=jdbc:mysql://h/shop\n' }).dialect, 'mysql');
  assert.equal(layout({ 'src/main/resources/application.yml': '# url: jdbc:oracle:thin:@x\nspring:\n  datasource:\n    url: jdbc:postgresql://h/shop\n' }).dialect, 'postgres');
  // no config in resources: the build file at the module root
  assert.equal(layout({ 'pom.xml': '<dependencies><dependency><groupId>org.flywaydb</groupId><artifactId>flyway-sqlserver</artifactId></dependency></dependencies>' }).dialect, 'mssql');
  assert.equal(layout({ 'pom.xml': '<dependency><artifactId>flyway-database-oracle</artifactId></dependency>' }).dialect, 'oracle');
  assert.equal(layout({ 'build.gradle.kts': 'dependencies {\n  implementation("org.flywaydb:flyway-database-db2")\n}\n' }).dialect, 'db2');
  assert.equal(layout({ 'build.gradle': "dependencies {\n  implementation 'org.flywaydb:flyway-mysql'\n}" }).dialect, 'mysql');
  assert.equal(layout({ 'pom.xml': '<dependency><artifactId>flyway-database-postgresql</artifactId></dependency>' }).dialect, 'postgres');
  // JDBC drivers are weaker evidence than Flyway's own module, and a Testcontainers dependency says nothing
  const driver = layout({ 'pom.xml': '<dependency><groupId>com.oracle.database.jdbc</groupId><artifactId>ojdbc11</artifactId></dependency>' });
  assert.deepEqual([driver.dialect, driver.strong], ['oracle', false]);
  assert.equal(layout({ 'build.gradle': "dependencies {\n  runtimeOnly 'com.microsoft.sqlserver:mssql-jdbc'\n  testImplementation 'org.testcontainers:postgresql'\n}" }).dialect, 'mssql');
  assert.equal(layout({ 'pom.xml': '<dependency><artifactId>mssql-jdbc</artifactId></dependency><dependency><groupId>org.testcontainers</groupId><artifactId>postgresql</artifactId><scope>test</scope></dependency>' }).dialect, 'mssql');
  assert.equal(layout({ 'pom.xml': '<dependency><artifactId>mysql-connector-j</artifactId></dependency>' }).dialect, 'mysql');
  assert.equal(layout({ 'build.gradle': "dependencies { implementation 'org.mariadb.jdbc:mariadb-java-client' }" }).dialect, 'mysql');
  assert.equal(layout({ 'build.gradle': "dependencies { implementation 'com.ibm.db2:jcc:11.5.9.0' }" }).dialect, 'db2');
});

test('Spring Boot end to end: marker-free Oracle SQL under src/main/resources/db/migration gets the Oracle rules', (t) => {
  const dir = scratch(t);
  put(dir, 'src/main/resources/application.yml', 'spring:\n  datasource:\n    url: jdbc:oracle:thin:@//h:1521/XEPDB1\n');
  put(dir, 'src/main/resources/db/migration/V1__index.sql', ORACLE_SQL);
  const r = lintJson(join(dir, 'src', 'main', 'resources', 'db', 'migration'));
  assert.ok(r.rules.includes('oracle-index-not-online'), r.rules.join());
});

test('the nearest directory with a hint decides, and Prisma\'s declared provider still outranks the syntax', (t) => {
  const dir = scratch(t);
  put(dir, 'docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n');
  put(dir, 'svc/flyway.conf', 'flyway.url=jdbc:oracle:thin:@//h:1521/XEPDB1\n');
  put(dir, 'svc/sql/V1__x.sql', ORACLE_SQL);
  assert.equal(projectDialect(join(dir, 'svc', 'sql', 'V1__x.sql')).dialect, 'oracle');
  const prisma = scratch(t);
  put(prisma, 'prisma/migrations/migration_lock.toml', 'provider = "sqlserver"\n');
  const info = projectDialect(join(prisma, 'prisma', 'migrations', '0001_x', 'migration.sql'));
  assert.deepEqual([info.dialect, info.declared], ['mssql', true]);
});
