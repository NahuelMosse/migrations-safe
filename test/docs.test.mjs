import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RULES } from '../skills/migrations-safe/scripts/lib/rules.mjs';
import { FIXTURES, ROOT, SKILL, lintCli } from './helpers.mjs';

const read = (p) => readFileSync(p, 'utf8');

test('the rule table in references/rules.md is the rule registry', () => {
  const rows = [...read(join(SKILL, 'references/rules.md')).matchAll(/^\| `([a-z-]+)` \| (error|warning) \|/gm)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(rows.sort(), RULES.map((r) => `${r.id}:${r.level}`).sort());
});

test('SKILL.md: frontmatter, size, variables and links', () => {
  const text = read(join(SKILL, 'SKILL.md'));
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
  const description = front.match(/^description: (.*)$/m)[1];
  assert.ok(description.length <= 700, `description is ${description.length} chars`);
  assert.match(front, /^name: migrations-safe$/m);
  assert.match(front, /^allowed-tools: Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/\*\)$/m);
  assert.ok(text.split('\n').length < 500);
  assert.ok(!text.includes('<skill-dir>'));
  assert.match(text, /\$\{CLAUDE_SKILL_DIR\}\/scripts\/migration-lint\.mjs/);
  assert.match(text, /Node 22\.13\+/);
  assert.match(text, /0 errors, or each remaining finding is allowed in the file with its\s+reason/);
  for (const [, link] of text.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(existsSync(join(SKILL, link)), link);
  for (const ref of ['rules', 'runners', 'rehearsal']) assert.ok(text.includes(`references/${ref}.md`));
  assert.ok(!/db:migrate:status` \+/.test(text));
});

test('packaging files agree with each other', () => {
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const plugin = JSON.parse(read(join(ROOT, '.claude-plugin/plugin.json')));
  const market = JSON.parse(read(join(ROOT, '.claude-plugin/marketplace.json')));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.engines.node, '>=22.13');
  for (const bin of Object.values(pkg.bin)) assert.ok(existsSync(join(ROOT, bin)), bin);
  assert.equal(plugin.name, 'migrations-safe');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, 'MIT');
  assert.equal(market.name, 'migrations-safe');
  assert.deepEqual(market.plugins, [{ name: 'migrations-safe', source: './' }]);
  assert.match(read(join(ROOT, 'CHANGELOG.md')), new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')}\\b`, 'm'));
  assert.match(read(join(ROOT, 'LICENSE')), /^MIT License[\s\S]*Copyright \(c\) 2026 Nahuel Mosse/);
  assert.ok(!existsSync(join(ROOT, 'evals.md')));
});

test('every eval case has a prompt and a grader', () => {
  const dir = join(ROOT, 'evals');
  const cases = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.equal(cases.length, 10);
  for (const c of cases) {
    assert.ok(existsSync(join(dir, c.name, 'prompt.md')), `${c.name}/prompt.md`);
    const graders = readdirSync(join(dir, c.name, 'graders')).filter((f) => f.endsWith('.md'));
    assert.ok(graders.length >= 1, c.name);
    for (const g of graders) assert.match(read(join(dir, c.name, 'graders', g)), /^---\ntype: (tool_used|llm)\n/);
  }
});

const rulesOf = (dir, extra = []) => {
  const r = lintCli([join(FIXTURES, dir), '--format', 'json', ...extra]);
  return { code: r.code, found: JSON.parse(r.out).findings.map((f) => `${f.level}:${f.rule}`).sort() };
};

test('fixtures: good ones are clean even with --fail-on warning, bad ones fail with exactly the advertised rules', () => {
  for (const dir of ['good/postgres', 'good/sqlite']) assert.deepEqual(rulesOf(dir, ['--strict']), { code: 0, found: [] }, dir);
  assert.deepEqual(rulesOf('bad/postgres').found, [
    'error:change-column-type', 'error:concurrently-in-transaction', 'error:constraint-without-not-valid', 'error:drop-column',
    'error:drop-table', 'error:index-without-concurrently', 'error:not-null-without-default', 'error:rename-column',
    'error:rename-table', 'error:set-not-null', 'error:update-all', 'error:volatile-default',
    'warning:missing-down', 'warning:missing-down', 'warning:missing-lock-timeout', 'warning:not-atomic',
  ]);
  assert.deepEqual(rulesOf('bad/sqlite').found, [
    'error:delete-all', 'error:drop-column', 'error:not-null-without-default', 'warning:missing-down', 'warning:missing-down', 'warning:not-atomic',
  ]);
  assert.deepEqual(rulesOf('bad/postgres-locks').found, [
    'error:constraint-builds-index', 'error:drop-index-without-concurrently', 'error:drop-materialized-view', 'error:drop-schema-cascade',
    'error:primary-key-using-index', 'error:rewriting-column', 'error:truncate', 'warning:missing-down', 'warning:not-atomic',
  ]);
  assert.deepEqual(rulesOf('bad/mysql').found, ['error:change-column-type', 'error:rename-table', 'warning:missing-down', 'warning:mysql-no-algorithm']);
  assert.deepEqual(rulesOf('bad/sqlite-rebuild').found, ['error:prisma-data-loss-warning', 'warning:missing-down', 'warning:not-atomic']);
  for (const dir of ['bad/postgres', 'bad/sqlite', 'bad/postgres-locks', 'bad/mysql', 'bad/sqlite-rebuild']) assert.equal(rulesOf(dir).code, 1, dir);
});
