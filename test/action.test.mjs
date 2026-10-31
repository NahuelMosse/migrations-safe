// action.yml: a composite action that runs the package's migration-lint from the action's own checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

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

test('the single run line invokes the packaged migration-lint with the args input, from the action checkout', () => {
  const runs = [...text.matchAll(/^ {6}run: (.+)$/gm)].map((m) => m[1]);
  assert.equal(runs.length, 1, 'one run line, no inline script');
  const bin = pkg.bin['migration-lint'];
  assert.equal(runs[0], `node "\${{ github.action_path }}/${bin}" $MSAFE_ARGS`);
  assert.match(text, /^ {8}MSAFE_ARGS: \$\{\{ inputs\.args \}\}$/m, 'args reach the shell through the environment, not interpolated into the script');
  assert.match(text, /node-version: \$\{\{ inputs\.node-version \}\}/);
  assert.match(text, /^ {4}- shell: bash$/m);
});
