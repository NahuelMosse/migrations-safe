// The npm package and the vendored skill: what is published, that the tarball installs and runs, and that the skill
// directory alone (what `npx skills add` copies) holds a working CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FIXTURES, ROOT, SKILL } from './helpers.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const json = (...p) => JSON.parse(readFileSync(join(ROOT, ...p), 'utf8'));
const tempDir = () => mkdtempSync(join(tmpdir(), 'msafe-pkg-'));

// npm is a .cmd shim on Windows, which only runs through a shell; every argument passed here is a plain word or a path without spaces.
const npm = (args, cwd) => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 });
const node = (args, cwd) => run(process.execPath, args, { cwd, encoding: 'utf8' }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('package.json is publishable and its version matches the plugin manifest', () => {
  const pkg = json('package.json');
  assert.equal(pkg.name, 'migrations-safe');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.version, json('.claude-plugin', 'plugin.json').version);
  assert.deepEqual(pkg.bin, {
    'migration-lint': 'skills/migrations-safe/scripts/migration-lint.mjs',
    rehearse: 'skills/migrations-safe/scripts/rehearse.mjs',
    'rehearse-sqlite': 'skills/migrations-safe/scripts/rehearse-sqlite.mjs',
  });
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
  assert.equal(pkg.dependencies, undefined, 'zero runtime dependencies');
  assert.match(pkg.repository.url, /^git\+https:\/\/github\.com\/NahuelMosse\/migrations-safe\.git$/);
});

test('the tarball holds exactly the expected files, installs into an empty project and runs the bins', async () => {
  const dest = tempDir();
  const { stdout } = await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', dest], ROOT);
  const [packed] = JSON.parse(stdout.slice(stdout.indexOf('[')));
  assert.ok(existsSync(join(dest, packed.filename)), `npm reported ${packed.filename}`);
  assert.deepEqual(packed.files.map((f) => f.path).sort(), json('test', 'expected-package-files.json'));

  const project = tempDir();
  writeFileSync(join(project, 'package.json'), '{"name":"consumer","private":true}');
  await npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', join(dest, packed.filename)], project);
  const installed = join(project, 'node_modules', 'migrations-safe');
  const bin = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).bin;
  const entry = (name) => join(installed, ...bin[name].split('/'));

  for (const name of ['migration-lint', 'rehearse', 'rehearse-sqlite']) {
    const viaShim = await npm(['exec', '--no-install', '--', name, '--help'], project);
    assert.match(viaShim.stdout, /usage/i, name);
    const direct = await node([entry(name), '--help'], project);
    assert.equal(direct.code, 0, `${name}: ${direct.stderr}`);
  }

  const migrations = join(project, 'db');
  mkdirSync(migrations);
  cpSync(join(FIXTURES, 'good', 'postgres'), migrations, { recursive: true });
  const lint = await node([entry('migration-lint'), 'db', '--strict'], project);
  assert.equal(lint.code, 0, lint.stdout + lint.stderr);
  const bad = await node([entry('migration-lint'), join(FIXTURES, 'bad', 'postgres')], project);
  assert.equal(bad.code, 1, bad.stdout + bad.stderr);

  const rehearsal = await node([entry('rehearse'), join(FIXTURES, 'seed-sqlite.sql'), join(FIXTURES, 'good', 'sqlite', '0007_tasks_due.sql')], project);
  assert.equal(rehearsal.code, 0, rehearsal.stdout + rehearsal.stderr);
});

const sourceFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []);

test('the skill directory alone is self-contained: it runs and every import stays inside it', async () => {
  const copy = join(tempDir(), 'migrations-safe');
  mkdirSync(copy);
  cpSync(SKILL, copy, { recursive: true });
  const help = await node([join(copy, 'scripts', 'migration-lint.mjs'), '--help'], tempDir());
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /usage/i);

  const files = sourceFiles(copy);
  assert.ok(files.length > 10);
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"\n]*?\bfrom\s+(['"])([^'"\n]+)\1|^\s*import\s+(['"])([^'"\n]+)\3|\bimport\(\s*(['"])([^'"\n]+)\5/gm)) {
      const spec = m[2] ?? m[4] ?? m[6];
      checked++;
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${relative(copy, file)} imports ${spec}: only node: builtins and relative files are allowed`);
      const target = resolve(dirname(file), spec);
      assert.ok(!relative(copy, target).startsWith('..'), `${relative(copy, file)} imports ${spec}, outside the skill directory`);
      assert.ok(existsSync(target), `${relative(copy, file)} imports ${spec}, which does not exist in the skill directory`);
    }
  }
  assert.ok(checked > 20, `found only ${checked} imports: the pattern no longer matches the sources`);
});
