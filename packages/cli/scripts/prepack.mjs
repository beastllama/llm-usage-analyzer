// Runs before `npm pack` and `npm publish`.
// 1. Stops the publish if the dashboard or the built command is missing, so a broken package never goes out.
// 2. Checks the command's first line. A Windows line ending (CR) there breaks `npx` on macOS and Linux.
// 3. Copies the README and LICENSE in, so the npm page shows them.
// 4. Writes npm-shrinkwrap.json: the exact version of every package the command needs when it runs (and nothing it
//    only needs to be built). npm installs from it, so `npx llm-usage-analyzer` gets what was tested, and a new
//    version of a dependency cannot reach users until there is a new release of this package.
//    It is made from package-lock.json, so the versions are the ones this repository already pinned.
//    postpack.mjs removes it again, so it never sits next to the development lock file.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!fs.existsSync(here('../web/index.html'))) {
  fail('packages/cli/web/index.html is missing. Run "npm run build:app" in the repo root first.');
}

if (!fs.existsSync(here('../web/THIRD_PARTY_NOTICES.txt'))) {
  fail('packages/cli/web/THIRD_PARTY_NOTICES.txt is missing. Run "npm run build:app" in the repo root first.');
}

if (!fs.existsSync(here('../dist/index.js'))) {
  fail('packages/cli/dist/index.js is missing. Run "npm run build" in packages/cli first.');
}
const firstLine = fs.readFileSync(here('../dist/index.js'), 'utf8').split('\n')[0];
if (firstLine !== '#!/usr/bin/env node') {
  fail(`The first line of dist/index.js must be exactly "#!/usr/bin/env node". Found: ${JSON.stringify(firstLine)}`);
}

for (const f of ['README.md', 'LICENSE']) fs.copyFileSync(here(`../../../${f}`), here(`../${f}`));

// ---- the pinned list of runtime dependencies
const pkg = JSON.parse(fs.readFileSync(here('../package.json'), 'utf8'));
const lockFile = here('../package-lock.json');
if (!fs.existsSync(lockFile)) fail('packages/cli/package-lock.json is missing, so the dependency versions cannot be pinned. Run "npm install" in packages/cli.');

const devLock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));

// npm run from inside npm (this script) inherits npm's settings as npm_config_* variables. `npm pack --dry-run` and
// `npm publish --dry-run` would make the nested npm a dry run too, and it would then keep every build tool in the list.
// So the nested npm starts without any of them. It still reads the user's own .npmrc.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-shrinkwrap-'));
try {
  // The same name, version and runtime dependencies, with the lock file that already pins them
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, dependencies: pkg.dependencies }, null, 2));
  fs.copyFileSync(lockFile, path.join(tmp, 'package-lock.json'));
  const npm = (args) => {
    // Windows runs npm through a .cmd file, which needs a shell (one command string, so Node does not warn about arguments)
    const win = process.platform === 'win32';
    const r = win
      ? spawnSync(`npm ${args.join(' ')}`, { cwd: tmp, env: cleanEnv, shell: true, encoding: 'utf8' })
      : spawnSync('npm', args, { cwd: tmp, env: cleanEnv, encoding: 'utf8' });
    if (r.status !== 0) fail(`Could not write the pinned dependency list ("npm ${args.join(' ')}" failed):\n${r.stderr || r.stdout || r.error}`);
  };
  npm(['install', '--package-lock-only', '--no-dry-run', '--ignore-scripts', '--no-audit', '--no-fund']);
  npm(['shrinkwrap', '--no-dry-run']);
  fs.copyFileSync(path.join(tmp, 'npm-shrinkwrap.json'), here('../npm-shrinkwrap.json'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- check the list before it goes into a package. npm made it, but this does not trust npm's flags:
// the list must hold what the command needs to run, exactly that, at the versions package-lock.json already pins.
const wrapped = JSON.parse(fs.readFileSync(here('../npm-shrinkwrap.json'), 'utf8'));
const packages = wrapped.packages ?? {};
const root = packages[''] ?? {};
if (JSON.stringify(root.dependencies ?? {}) !== JSON.stringify(pkg.dependencies ?? {})) {
  fail('The pinned dependency list does not start from the dependencies in package.json.');
}

// Walk from the command's own dependencies, finding each one the way Node does: the nearest node_modules folder, going up
const reached = new Set();
const lookUp = (from, name) => {
  for (let base = from; ; ) {
    const candidate = `${base}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (base === '') return undefined;
    base = base.slice(0, base.lastIndexOf('node_modules/'));
  }
};
const visit = (from, deps) => {
  for (const name of Object.keys(deps ?? {})) {
    const found = lookUp(from, name);
    if (!found || reached.has(found)) continue;
    reached.add(found);
    const entry = packages[found];
    visit(`${found}/`, { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies });
  }
};
visit('', pkg.dependencies);

const extra = Object.keys(packages).filter((name) => name !== '' && !reached.has(name));
if (extra.length > 0) {
  fail(`The pinned dependency list should hold only what the command needs to run, but it also has ${extra.length} more, such as: ${extra.slice(0, 5).join(', ')}`);
}
const flagged = Object.entries(packages).filter(([, v]) => v && (v.dev || v.extraneous)).map(([k]) => k);
if (flagged.length > 0) fail(`The pinned dependency list has packages npm marks as not needed: ${flagged.slice(0, 5).join(', ')}`);

// Same name, same version, same checksum as in package-lock.json (wherever npm placed it), so the package that is released
// is the one that was tested
const nameOf = (lockPath) => lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
const pinned = new Map(Object.entries(devLock.packages ?? {}).filter(([k]) => k !== '').map(([k, v]) => [`${nameOf(k)}@${v.version}`, v.integrity]));
const drifted = Object.entries(packages).filter(([k, v]) => {
  if (k === '') return false;
  const key = `${nameOf(k)}@${v.version}`;
  return !pinned.has(key) || Boolean(pinned.get(key) && v.integrity && pinned.get(key) !== v.integrity);
}).map(([k]) => nameOf(k));
if (drifted.length > 0) {
  fail(`package-lock.json and package.json do not agree (${drifted.slice(0, 5).join(', ')}). Run "npm install" in packages/cli and commit the lock file.`);
}
