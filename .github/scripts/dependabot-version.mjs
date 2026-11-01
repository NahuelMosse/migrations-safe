// Run on a Dependabot pull request: when the update reaches what npm installs (dependencies, peerDependencies,
// optionalDependencies or npm-shrinkwrap.json), raise the patch version in package.json and plugin.json and add the
// CHANGELOG entry, so that merging the pull request publishes it (release.yml). An update that only touches development
// tooling leaves the version alone. Writes `bumped=true|false` to $GITHUB_OUTPUT.
// Usage: node .github/scripts/dependabot-version.mjs <base sha> <pull request title>
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [base, title] = process.argv.slice(2);
if (!base || !title) throw new Error('usage: dependabot-version.mjs <base sha> <pull request title>');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const output = (bumped) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `bumped=${bumped}\n`);
const SHIPPED = ['dependencies', 'peerDependencies', 'optionalDependencies'];

const before = JSON.parse(git('show', `${base}:package.json`));
const after = JSON.parse(readFileSync('package.json', 'utf8'));
const shippedChanged = SHIPPED.some((field) => JSON.stringify(before[field] ?? {}) !== JSON.stringify(after[field] ?? {}))
  || git('diff', '--name-only', base, 'HEAD', '--', 'npm-shrinkwrap.json').trim() !== '';

if (!shippedChanged) {
  console.log('the update does not reach the published package: version unchanged');
  output(false);
} else if (after.version !== before.version) {
  console.log(`version already raised to ${after.version} on this branch`);
  output(false);
} else if (!published(after.name, after.version)) {
  console.log(`${after.name}@${after.version} is not on npm yet: the update ships with it`);
  output(false);
} else {
  const [major, minor, patch] = after.version.split('-')[0].split('.').map(Number);
  const next = `${major}.${minor}.${patch + 1}`;
  setVersion('package.json', after.version, next);
  if (existsSync('.claude-plugin/plugin.json')) setVersion('.claude-plugin/plugin.json', after.version, next);
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const subject = title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
  const entry = `## ${next}\n\n${subject[0].toUpperCase()}${subject.slice(1)}.\n\n`;
  writeFileSync('CHANGELOG.md', changelog.replace(/^(# Changelog\n\n)/, `$1${entry}`));
  if (!readFileSync('CHANGELOG.md', 'utf8').includes(`## ${next}\n`)) throw new Error('CHANGELOG.md does not start with "# Changelog"');
  console.log(`${after.version} -> ${next}`);
  output(true);
}

function published(name, version) {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === version;
  } catch (error) {
    // E404: the package itself is not on npm yet. Any other failure (registry down) must not pass as "not published".
    if (String(error.stderr).includes('E404')) return false;
    throw error;
  }
}

function setVersion(file, from, to) {
  const text = readFileSync(file, 'utf8');
  const updated = text.replace(`"version": "${from}"`, `"version": "${to}"`);
  if (updated === text) throw new Error(`${file} has no "version": "${from}"`);
  writeFileSync(file, updated);
}
