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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-shrinkwrap-'));
try {
  // The same name, version and runtime dependencies, with the lock file that already pins them
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, dependencies: pkg.dependencies }, null, 2));
  fs.copyFileSync(lockFile, path.join(tmp, 'package-lock.json'));
  const npm = (args) => {
    // Windows runs npm through a .cmd file, which needs a shell (one command string, so Node does not warn about arguments)
    const win = process.platform === 'win32';
    const r = win
      ? spawnSync(`npm ${args.join(' ')}`, { cwd: tmp, shell: true, encoding: 'utf8' })
      : spawnSync('npm', args, { cwd: tmp, encoding: 'utf8' });
    if (r.status !== 0) fail(`Could not write the pinned dependency list ("npm ${args.join(' ')}" failed):\n${r.stderr || r.stdout || r.error}`);
  };
  npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
  npm(['shrinkwrap']);
  fs.copyFileSync(path.join(tmp, 'npm-shrinkwrap.json'), here('../npm-shrinkwrap.json'));

  const wrapped = JSON.parse(fs.readFileSync(here('../npm-shrinkwrap.json'), 'utf8'));
  const dev = Object.entries(wrapped.packages ?? {}).filter(([, v]) => v && v.dev).map(([k]) => k);
  if (dev.length > 0) fail(`The pinned dependency list should hold runtime packages only, but it has: ${dev.join(', ')}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
