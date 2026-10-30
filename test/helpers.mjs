import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSql } from '../skills/migrations-safe/scripts/lib/rules.mjs';
import { profileOf } from '../skills/migrations-safe/scripts/lib/runners.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = join(ROOT, 'skills', 'migrations-safe');
export const LINT = join(SKILL, 'scripts', 'migration-lint.mjs');
export const REHEARSE = join(SKILL, 'scripts', 'rehearse-sqlite.mjs');
export const FIXTURES = join(SKILL, 'fixtures');

// Rule ids found in `sql`, sorted; ctx as for lintSql, with `runner` as a shortcut for a profile.
export const ids = (sql, ctx = {}) => lintSql(sql, { ...ctx, profile: ctx.runner ? profileOf(ctx.runner) : ctx.profile }).findings.map((f) => f.rule).sort();
export const findings = (sql, ctx = {}) => lintSql(sql, { ...ctx, profile: ctx.runner ? profileOf(ctx.runner) : ctx.profile }).findings;

export const node = (script, args, { input, cwd } = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input, cwd, windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
export const lintCli = (args, opts) => node(LINT, args, opts);
export const rehearseCli = (args, opts) => node(REHEARSE, args, opts);

// A scratch directory under the OS temp dir that removes itself when the test ends.
export const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'msafe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const put = (root, rel, content = '') => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' };
export const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

// A repository on `main` with the given files committed.
export const makeRepo = (t, files) => {
  const dir = scratch(t);
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) put(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  return dir;
};
export const commitAll = (dir, message = 'change') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); };
