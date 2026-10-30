import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { commitAll, git, lintCli, makeRepo, put, scratch } from './helpers.mjs';

const SQL = 'CREATE TABLE t (id int);\n';

// Runs the history checks of the repo and returns { code, rules, findings, out }.
const history = (repo, ...extra) => historyWith(repo, undefined, ...extra);
const historyWith = (repo, input, ...extra) => {
  const r = lintCli(['--history', '--repo', repo, '--format', 'json', ...extra], { cwd: repo, input });
  let json = null;
  try { json = JSON.parse(r.out); } catch { /* not JSON: a failure in text form */ }
  return { code: r.code, json, rules: (json?.findings ?? []).map((f) => `${f.rule}:${f.file}`).sort(), out: r.out, err: r.err };
};
const branch = (repo, name = 'feature') => git(repo, 'checkout', '-q', '-b', name);

test('an edited, renamed or deleted applied migration is an error; a new one is fine', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL, 'db/migrations/0002_b.sql': SQL, 'db/migrations/0003_c.sql': SQL });
  branch(repo);
  put(repo, 'db/migrations/0001_a.sql', `${SQL}-- edited\n`);
  git(repo, 'mv', 'db/migrations/0002_b.sql', 'db/migrations/0002_renamed.sql');
  git(repo, 'rm', '-q', 'db/migrations/0003_c.sql');
  put(repo, 'db/migrations/0004_d.sql', SQL);
  commitAll(repo);
  const r = history(repo, '--runner', 'flyway');
  assert.equal(r.code, 1);
  assert.deepEqual(r.rules.filter((x) => x.startsWith('applied')), [
    'applied-migration-changed:db/migrations/0001_a.sql',
    'applied-migration-changed:db/migrations/0002_b.sql',
    'applied-migration-changed:db/migrations/0003_c.sql',
  ]);
  assert.ok(!r.rules.some((x) => x.includes('0004_d')));
});

test('with no edits only the new migrations are linted; none new is a pass with a note', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  branch(repo);
  const none = history(repo);
  assert.equal(none.code, 0);
  assert.equal(none.json.files, 0);
  assert.match(lintCli(['--history', '--repo', repo], { cwd: repo }).out, /no new migrations since/);
  put(repo, 'db/migrations/0002_b.sql', 'ALTER TABLE t DROP COLUMN c;\n');
  commitAll(repo);
  const r = history(repo);
  assert.equal(r.code, 1);
  assert.equal(r.json.files, 1);
  assert.ok(r.rules.some((x) => x.startsWith('drop-column:') && x.endsWith('0002_b.sql')));
});

test('out-of-order and duplicate sequence', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL, 'db/migrations/0003_c.sql': SQL });
  branch(repo);
  put(repo, 'db/migrations/0002_late.sql', SQL);
  put(repo, 'db/migrations/0003_other.sql', SQL);
  commitAll(repo);
  const r = history(repo);
  assert.ok(r.rules.includes('out-of-order:db/migrations/0002_late.sql'));
  assert.ok(r.rules.some((x) => x.startsWith('duplicate-sequence:')));
  assert.equal(r.code, 1);
});

test('lenient runners (dbmate) warn about order instead of failing; graph runners (Django) are not checked', (t) => {
  const files = { 'db/migrations/0001_a.sql': SQL, 'db/migrations/0003_c.sql': SQL };
  const repo = makeRepo(t, files);
  branch(repo);
  put(repo, 'db/migrations/0002_late.sql', SQL);
  commitAll(repo);
  const level = (extra) => history(repo, ...extra).json.findings.find((f) => f.rule === 'out-of-order')?.level;
  assert.equal(level(['--runner', 'dbmate']), 'warning');
  assert.equal(level(['--runner', 'django']), undefined);
  assert.equal(level(['--runner', 'alembic']), undefined);
  assert.equal(level(['--runner', 'goose']), 'error');
});

test('Flyway: V1 and V1_0 are the same version; R__ repeatable files may change', (t) => {
  const repo = makeRepo(t, { 'flyway.conf': '', 'sql/V1__init.sql': SQL, 'sql/V2__more.sql': SQL, 'sql/R__views.sql': 'CREATE OR REPLACE VIEW v AS SELECT 1;\n' });
  branch(repo);
  put(repo, 'sql/V1_0__again.sql', SQL);
  put(repo, 'sql/R__views.sql', 'CREATE OR REPLACE VIEW v AS SELECT 2;\n');
  commitAll(repo);
  const r = history(repo);
  assert.ok(r.rules.some((x) => x.startsWith('duplicate-sequence:')), r.rules.join());
  assert.ok(!r.rules.some((x) => x.includes('R__views') && x.startsWith('applied')));
  put(repo, 'sql/V2__more.sql', `${SQL}-- edited\n`);
  commitAll(repo);
  assert.ok(history(repo).rules.includes('applied-migration-changed:sql/V2__more.sql'));
});

test('Drizzle: the default drizzle/ folder is watched, _journal.json and snapshots may change', (t) => {
  const repo = makeRepo(t, {
    'drizzle.config.ts': "export default { dialect: 'postgresql', out: './drizzle' };\n",
    'drizzle/0000_init.sql': SQL, 'drizzle/meta/_journal.json': '{"entries":[]}\n', 'drizzle/meta/0000_snapshot.json': '{}\n',
  });
  branch(repo);
  put(repo, 'drizzle/0001_next.sql', SQL);
  put(repo, 'drizzle/meta/_journal.json', '{"entries":[{"idx":1}]}\n');
  put(repo, 'drizzle/meta/0001_snapshot.json', '{}\n');
  commitAll(repo);
  const ok = history(repo);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(ok.rules, []);
  put(repo, 'drizzle/0000_init.sql', `${SQL}-- edited\n`);
  commitAll(repo);
  assert.deepEqual(history(repo).rules.filter((x) => x.startsWith('applied')), ['applied-migration-changed:drizzle/0000_init.sql']);
});

test('Liquibase: the master changelog is a manifest, an included changelog is immutable', (t) => {
  const repo = makeRepo(t, {
    'liquibase.properties': 'changeLogFile=db/changelog/db.changelog-master.xml\n',
    'db/changelog/db.changelog-master.xml': '<databaseChangeLog/>\n', 'db/changelog/001-init.xml': '<databaseChangeLog/>\n',
  });
  branch(repo);
  put(repo, 'db/changelog/db.changelog-master.xml', '<databaseChangeLog><include file="002.xml"/></databaseChangeLog>\n');
  put(repo, 'db/changelog/002-more.xml', '<databaseChangeLog/>\n');
  commitAll(repo);
  assert.deepEqual(historyWith(repo, 'SELECT 1;\n', '-').rules.filter((x) => x.startsWith('applied')), []);
  put(repo, 'db/changelog/001-init.xml', '<databaseChangeLog><!-- edited --></databaseChangeLog>\n');
  commitAll(repo);
  assert.deepEqual(historyWith(repo, 'SELECT 1;\n', '-').rules.filter((x) => x.startsWith('applied')), ['applied-migration-changed:db/changelog/001-init.xml']);
});

test('Django squashmigrations and Alembic date-named revisions are not order errors', (t) => {
  const repo = makeRepo(t, { 'manage.py': '', 'app/migrations/0001_initial.py': '#\n', 'app/migrations/0002_b.py': '#\n' });
  branch(repo);
  put(repo, 'app/migrations/0001_squashed_0002_b.py', '#\n');
  commitAll(repo);
  const r = historyWith(repo, 'SELECT 1;\n', '-');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.rules.filter((x) => /out-of-order|duplicate/.test(x)), []);
  assert.ok(r.rules.includes('unlinted-migration:app/migrations/0001_squashed_0002_b.py'), 'non-SQL migrations are reported, not skipped silently');
});

test('a branch that is not rebased on main does not look like it deleted main\'s later migrations', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  branch(repo);
  put(repo, 'db/migrations/0003_mine.sql', SQL);
  commitAll(repo, 'branch work');
  git(repo, 'checkout', '-q', 'main');
  put(repo, 'db/migrations/0002_main_later.sql', SQL);
  put(repo, 'db/migrations/0004_main_latest.sql', SQL);
  commitAll(repo, 'main moves on');
  git(repo, 'checkout', '-q', 'feature');
  const r = history(repo, '--base', 'main');
  assert.ok(!r.rules.some((x) => x.startsWith('applied-migration-changed')), r.rules.join());
  // ordering uses the tip of main: 0003 sorts before main's 0004
  assert.ok(r.rules.includes('out-of-order:db/migrations/0003_mine.sql'));
  assert.equal(r.code, 1);
});

test('the same sequence as a migration main added after the branch point is a duplicate', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  branch(repo);
  put(repo, 'db/migrations/0002_mine.sql', SQL);
  commitAll(repo);
  git(repo, 'checkout', '-q', 'main');
  put(repo, 'db/migrations/0002_theirs.sql', SQL);
  commitAll(repo);
  git(repo, 'checkout', '-q', 'feature');
  assert.ok(history(repo, '--base', 'main').rules.some((x) => x.startsWith('duplicate-sequence:')));
});

test('a shallow clone is exit 2 with the fix, never a silent pass', (t) => {
  const origin = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  branch(origin);
  put(origin, 'db/migrations/0002_b.sql', 'DROP TABLE t;\n');
  commitAll(origin);
  git(origin, 'checkout', '-q', 'main');
  const clones = scratch(t);
  const clone = join(clones, 'shallow');
  git(clones, 'clone', '-q', '--depth', '1', '--no-single-branch', pathToFileURL(origin).href, clone);
  git(clone, 'checkout', '-q', 'feature');
  const r = history(clone);
  assert.equal(r.code, 2);
  assert.match(r.json.error.message, /shallow clone/);
  assert.match(r.json.error.message, /fetch-depth: 0/);
  const full = join(clones, 'full');
  git(clones, 'clone', '-q', '--no-single-branch', pathToFileURL(origin).href, full);
  git(full, 'checkout', '-q', 'feature');
  const ok = history(full, '--base', 'origin/main');
  assert.equal(ok.code, 1);
  assert.ok(ok.rules.some((x) => x.startsWith('drop-table:')));
});

test('a push to main with nothing new compares HEAD with itself and passes with a note; --base HEAD~1 checks the push', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  put(repo, 'db/migrations/0002_b.sql', 'DROP TABLE t;\n');
  commitAll(repo);
  assert.equal(history(repo, '--base', 'main').code, 0);
  const push = history(repo, '--base', 'HEAD~1');
  assert.equal(push.code, 1);
  assert.ok(push.rules.some((x) => x.startsWith('drop-table:')));
});

test('history failures are exit 2: not a repository, unknown base, no base branch', (t) => {
  const dir = scratch(t);
  assert.equal(history(dir).code, 2);
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  assert.equal(history(repo, '--base', 'nope').code, 2);
  git(repo, 'branch', '-m', 'trunk');
  const r = history(repo);
  assert.equal(r.code, 2);
  assert.match(r.json.error.message, /no base branch/);
});

test('tables created by an earlier new migration of the branch are not "existing"', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  branch(repo);
  put(repo, 'db/migrations/0002_orders.sql', 'CREATE TABLE orders (id int);\n');
  put(repo, 'db/migrations/0003_idx.sql', 'CREATE INDEX orders_id_idx ON orders (id);\n');
  commitAll(repo);
  const r = history(repo, '--runner', 'flyway');
  assert.deepEqual(r.json.findings.map((f) => f.rule), []);
  rmSync(join(repo, 'db/migrations/0002_orders.sql'));
  put(repo, 'db/migrations/0002_orders.sql', 'SELECT 1;\n');
  assert.ok(history(repo, '--runner', 'flyway').json.findings.some((f) => f.rule === 'index-without-concurrently'));
});

test('new migrations that are all non-SQL are exit 2, never a pass with a "no new migrations" note', (t) => {
  for (const [files, fresh] of [
    [{ 'manage.py': '', 'app/migrations/0001_initial.py': '#\n' }, 'app/migrations/0002_b.py'],
    [{ 'config/application.rb': '', 'db/migrate/20260101000000_a.rb': '#\n' }, 'db/migrate/20260201000000_b.rb'],
  ]) {
    const repo = makeRepo(t, files);
    branch(repo);
    put(repo, fresh, '#\n');
    commitAll(repo);
    const r = history(repo);
    assert.equal(r.code, 2, r.out);
    assert.match(r.json.error.message, /none is SQL/);
    assert.ok(!/no new migrations/.test(r.out));
  }
});

test('Flyway without flyway.conf is recognised from file names: R__ files may change, V files may not', (t) => {
  const repo = makeRepo(t, { 'sql/V1__a.sql': SQL, 'sql/R__views.sql': 'SELECT 1;\n' });
  branch(repo);
  put(repo, 'sql/R__views.sql', 'SELECT 2;\n');
  commitAll(repo);
  assert.deepEqual(history(repo).rules, []);
  put(repo, 'sql/V1__a.sql', `${SQL}-- edited\n`);
  commitAll(repo);
  assert.deepEqual(history(repo).rules, ['applied-migration-changed:sql/V1__a.sql']);
});

test('R__ repeatable scripts are manifests whatever the runner', (t) => {
  const repo = makeRepo(t, { 'db/migrations/R__views.sql': 'SELECT 1;\n', 'db/migrations/0001_a.sql': SQL });
  branch(repo);
  put(repo, 'db/migrations/R__views.sql', 'SELECT 2;\n');
  commitAll(repo);
  assert.deepEqual(history(repo, '--runner', 'goose').rules, []);
});

test('Liquibase without liquibase.properties: a master changelog that includes others may change', (t) => {
  const repo = makeRepo(t, {
    'db/changelog/master.xml': '<databaseChangeLog><include file="001.xml"/></databaseChangeLog>\n',
    'db/changelog/001.xml': '<databaseChangeLog><changeSet id="1" author="a"/></databaseChangeLog>\n',
    'db/changelog/root.xml': '<databaseChangeLog><include file="001.xml"/></databaseChangeLog>\n',
  });
  branch(repo);
  put(repo, 'db/changelog/master.xml', '<databaseChangeLog><include file="001.xml"/><include file="002.xml"/></databaseChangeLog>\n');
  put(repo, 'db/changelog/root.xml', '<databaseChangeLog><include file="001.xml"/><include file="002.xml"/></databaseChangeLog>\n');
  put(repo, 'db/changelog/002.xml', '<databaseChangeLog><changeSet id="2" author="a"/></databaseChangeLog>\n');
  commitAll(repo);
  assert.deepEqual(historyWith(repo, 'SELECT 1;\n', '-').rules.filter((x) => x.startsWith('applied')), []);
  put(repo, 'db/changelog/001.xml', '<databaseChangeLog><changeSet id="1" author="b"/></databaseChangeLog>\n');
  commitAll(repo);
  assert.deepEqual(historyWith(repo, 'SELECT 1;\n', '-').rules.filter((x) => x.startsWith('applied')), ['applied-migration-changed:db/changelog/001.xml']);
});

test('dbmate recognised from its markers is lenient: an older new migration is a warning', (t) => {
  const dbmate = (n) => `-- migrate:up\nCREATE TABLE t${n} (id int);\n-- migrate:down\nDROP TABLE t${n};\n`;
  const repo = makeRepo(t, { 'db/migrations/20260101000000_a.sql': dbmate(1), 'db/migrations/20260301000000_c.sql': dbmate(3) });
  branch(repo);
  put(repo, 'db/migrations/20260201000000_b.sql', dbmate(2));
  commitAll(repo);
  const r = history(repo);
  assert.equal(r.json.findings.find((f) => f.rule === 'out-of-order').level, 'warning');
  assert.equal(r.code, 0, r.out);
});

test('Rails migrations are lenient: an older timestamp is a warning', (t) => {
  const repo = makeRepo(t, { 'db/migrate/20260101000000_a.rb': '#\n', 'db/migrate/20260301000000_c.rb': '#\n' });
  branch(repo);
  put(repo, 'db/migrate/20260201000000_b.rb', '#\n');
  commitAll(repo);
  const r = historyWith(repo, 'SELECT 1;\n', '-');
  assert.equal(r.json.findings.find((f) => f.rule === 'out-of-order').level, 'warning');
  assert.equal(r.code, 0, r.out);
});

test('finding paths are relative to the working directory for history and lint findings alike', (t) => {
  const repo = makeRepo(t, { 'db/migrations/0001_a.sql': SQL });
  branch(repo);
  put(repo, 'db/migrations/0001_a.sql', `${SQL}-- edited\n`);
  put(repo, 'db/migrations/0002_b.sql', 'DROP TABLE t;\n');
  commitAll(repo);
  const r = lintCli(['--history', '--repo', repo, '--format', 'json', '--runner', 'flyway'], { cwd: join(repo, 'db') });
  const files = JSON.parse(r.out).findings.map((f) => f.file);
  assert.ok(files.includes('migrations/0001_a.sql'), files.join());
  assert.ok(files.includes('migrations/0002_b.sql'), files.join());
  assert.ok(files.every((f) => f.startsWith('migrations/')));
});
