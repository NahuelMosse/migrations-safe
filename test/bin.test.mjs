// The `migrations-safe` command: dispatch to lint and rehearse, help, unknown commands, exit codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, SKILL, node, put, scratch } from './helpers.mjs';

const BIN = join(SKILL, 'scripts', 'migrations-safe.mjs');
const bin = (args, opts) => node(BIN, args, opts);

test('no command and an unknown command exit 2 with the usage', () => {
  const none = bin([]);
  assert.equal(none.code, 2);
  assert.match(none.err, /usage: migrations-safe <command>/);
  const unknown = bin(['lintt', 'x.sql']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command: lintt/);
  assert.equal(bin(['--version']).code, 2);
});

test('--help lists the commands, and each command has its own help', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const r = bin([flag]);
    assert.equal(r.code, 0);
    assert.match(r.out, /usage: migrations-safe <command>[\s\S]*lint[\s\S]*rehearse/);
  }
  const lint = bin(['lint', '--help']);
  assert.equal(lint.code, 0);
  assert.match(lint.out, /^usage: migrations-safe lint <file\|dir\|->/);
  const rehearse = bin(['rehearse', '--help']);
  assert.equal(rehearse.code, 0);
  assert.match(rehearse.out, /^usage: migrations-safe rehearse /);
});

test('lint forwards its arguments and its exit codes: 0 clean, 1 findings, 2 could not run', (t) => {
  assert.equal(bin(['lint', join(FIXTURES, 'good', 'postgres'), '--strict']).code, 0);
  const bad = bin(['lint', join(FIXTURES, 'bad', 'postgres'), '--format', 'json']);
  assert.equal(bad.code, 1);
  assert.ok(JSON.parse(bad.out).findings.length > 0);
  const dir = scratch(t);
  assert.equal(bin(['lint', join(dir, 'missing.sql')]).code, 2);
  assert.equal(bin(['lint', '--no-such-option']).code, 2);
  put(dir, 'ok.sql', 'CREATE TABLE a (id int);\n');
  assert.equal(bin(['lint', '-', '--dialect', 'postgres'], { input: 'CREATE TABLE a (id int);\n', cwd: dir }).code, 0);
});

test('rehearse forwards its arguments and its exit codes: 0 safe, 1 loss, 2 could not run', (t) => {
  const seed = join(FIXTURES, 'seed-sqlite.sql');
  assert.equal(bin(['rehearse', seed, join(FIXTURES, 'good', 'sqlite', '0007_tasks_due.sql')]).code, 0);
  assert.equal(bin(['rehearse', seed, join(FIXTURES, 'bad', 'sqlite-rebuild', '0009_tasks_drop_priority.sql')]).code, 1);
  assert.equal(bin(['rehearse', seed, join(scratch(t), 'missing.sql')]).code, 2);
  assert.equal(bin(['rehearse']).code, 2);
});

test('--args-from-env without a name exits 2', () => {
  const r = bin(['lint', '--args-from-env']);
  assert.equal(r.code, 2);
  assert.match(r.err, /needs the name of an environment variable/);
});
