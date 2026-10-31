// action.yml: a composite action that runs the package's `migrations-safe lint` from the action's own checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitArgs } from '../skills/migrations-safe/scripts/lib/args-env.mjs';
import { ROOT, put, scratch } from './helpers.mjs';

const text = readFileSync(join(ROOT, 'action.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// action.yml is flat enough to read without a YAML dependency: `key: value` lines, one level of nesting per input.
const scalar = (line) => line.trim().replace(/^'(.*)'$/, '$1');
const inputDefault = (name) => {
  const m = text.match(new RegExp(`^  ${name}:\\n(?:    .*\\n)*?    default: (.+)$`, 'm'));
  assert.ok(m, `input ${name} has a default`);
  return scalar(m[1]);
};

test('action.yml is a composite action with args and node-version inputs', () => {
  assert.match(text, /^runs:\n {2}using: composite$/m);
  assert.equal(inputDefault('args'), '--history --base origin/${{ github.base_ref }} --format github');
  assert.equal(inputDefault('node-version'), '24');
});

test('the single run line invokes the packaged bin with the lint command, from the action checkout', () => {
  const runs = [...text.matchAll(/^ {6}run: (.+)$/gm)].map((m) => m[1]);
  assert.equal(runs.length, 1, 'one run line, no inline script');
  assert.deepEqual(Object.keys(pkg.bin), ['migrations-safe']);
  const bin = pkg.bin['migrations-safe'];
  assert.equal(runs[0], `node "\${{ github.action_path }}/${bin}" lint --args-from-env MSAFE_ARGS`);
  assert.ok(!/\$\{\{ *inputs\./.test(runs[0]), 'inputs are never interpolated into the script');
  assert.match(text, /^ {8}MSAFE_ARGS: \$\{\{ inputs\.args \}\}$/m);
  assert.match(text, /node-version: \$\{\{ inputs\.node-version \}\}/);
  assert.match(text, /^ {4}- shell: bash$/m);
});

// What the run line does at run time: the bin takes MSAFE_ARGS, splits it and runs lint; nothing in it is expanded.
const BIN = join(ROOT, ...pkg.bin['migrations-safe'].split('/'));
const viaEnv = (value, cwd) => spawnSync(process.execPath, [BIN, 'lint', '--args-from-env', 'MSAFE_ARGS'], { cwd, encoding: 'utf8', env: { ...process.env, MSAFE_ARGS: value } });

test('splitArgs reads shell quoting and expands nothing', () => {
  assert.deepEqual(splitArgs('--history --base origin/main  --format github'), ['--history', '--base', 'origin/main', '--format', 'github']);
  assert.deepEqual(splitArgs(`a 'b c' "d e" f\\ g ''`),['a', 'b c', 'd e', 'f g', '']);
  assert.deepEqual(splitArgs('$(touch pwned); `id` $HOME | * && x'), ['$(touch', 'pwned);', '`id`', '$HOME', '|', '*', '&&', 'x']);
  assert.deepEqual(splitArgs('"say \\"hi\\" \\\\ $(x)"'), ['say "hi" \\ $(x)']);
  assert.deepEqual(splitArgs(''), []);
  assert.throws(() => splitArgs('"open'), /unterminated/);
});

test('the action command lints the arguments of the variable and never executes them', (t) => {
  const dir = scratch(t);
  put(dir, 'db/0001_ok.sql', 'CREATE TABLE a (id int);\n');
  const ok = viaEnv('db --fail-on error --format json', dir);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  put(dir, 'db/0002_bad.sql', 'DROP TABLE a;\n');
  assert.equal(viaEnv('db', dir).status, 1);

  const hostile = viaEnv('db $(touch pwned) ; touch pwned2 `touch pwned3` "$(touch pwned4)"', dir);
  assert.equal(hostile.status, 2, 'the tokens are paths that do not exist, not commands');
  for (const f of ['pwned', 'pwned2', 'pwned3', 'pwned4']) assert.ok(!existsSync(join(dir, f)), f);

  const unterminated = viaEnv('db "oops', dir);
  assert.equal(unterminated.status, 2);
  assert.match(unterminated.stderr, /unterminated/);
});
