// One command to release the CLI to npm:              npm run release
// To rehearse everything except the last step:        npm run release:rehearse
//
// It stops at the first problem and says what to do. In order:
//   1 your computer and git are ready          2 this version is new on npm
//   3 install       4 tests       5 build the dashboard and the command
//   6 pack, and check the file list            7 install the packed file somewhere else and run it
//   8 ask you, then publish (npm asks for your 2FA code)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'packages', 'cli');
const dry = process.argv.includes('--dry-run');
const win = process.platform === 'win32';
const TOTAL = 8;

const pkg = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8'));
let step = 0;

const say = (text) => console.log(`\n[${++step}/${TOTAL}] ${text}`);
const stop = (text) => {
  console.error(`\nSTOPPED: ${text}\n`);
  process.exit(1);
};
// cmd.exe needs quotes around paths with spaces
const q = (s) => (win ? `"${s}"` : s);

function run(cmd, args, { cwd = root, capture = false, allowFail = false } = {}) {
  const options = { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' };
  // Windows runs npm through a .cmd file, which needs a shell. One command string, so Node 24 does not warn about arguments.
  const r = win
    ? spawnSync([cmd, ...args].join(' '), { ...options, shell: true })
    : spawnSync(cmd, args, options);
  if (r.error) stop(`Could not run "${cmd}": ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    // Captured output is not on the screen, so show what the command said
    const said = capture ? `\n${(r.stderr || r.stdout || '').trim()}\n` : ' ';
    stop(`"${[cmd, ...args].join(' ')}" failed (exit ${r.status}).${said}Fix that, then run this again.`);
  }
  return r;
}
const out = (r) => (r.stdout || '').trim();

// 1 ---------------------------------------------------------------------------------------------
say('Checking your computer and git');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  stop(`Node ${process.versions.node} is too old to build the dashboard. Install Node 22.12 or newer from https://nodejs.org`);
}
const branch = out(run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }));
if (branch !== 'main') stop(`You are on "${branch}", not "main". Run: git checkout main`);
if (out(run('git', ['status', '--porcelain'], { capture: true }))) {
  stop('Some changes are not committed. Run "git status" to see them, then commit or discard them.');
}
// Without a fresh look at GitHub, "same as GitHub" would be a guess, so a failed fetch stops the release
const fetched = run('git', ['fetch', '--quiet', 'origin', 'main'], { capture: true, allowFail: true });
if (fetched.status !== 0) stop(`Could not reach GitHub to compare your main with it. Is the internet on, and is "origin" set?\n${(fetched.stderr || '').trim()}`);
const behind = out(run('git', ['rev-list', '--count', 'HEAD..origin/main'], { capture: true }));
const ahead = out(run('git', ['rev-list', '--count', 'origin/main..HEAD'], { capture: true }));
if (behind !== '0') stop(`Your main is ${behind} commit(s) behind GitHub. Run: git pull`);
if (ahead !== '0') stop(`Your main has ${ahead} commit(s) that GitHub does not have. Run: git push`);
console.log(`On main, nothing uncommitted, same as GitHub. Releasing ${pkg.name}@${pkg.version}.`);

// 2 ---------------------------------------------------------------------------------------------
say(`Checking that ${pkg.name}@${pkg.version} is new on npm`);
const seen = run('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { capture: true, allowFail: true });
if (seen.status === 0 && out(seen)) {
  stop(`${pkg.name}@${pkg.version} is already on npm. Raise "version" in packages/cli/package.json, commit, push, and run again.`);
}
if (seen.status !== 0 && !/E404/.test(seen.stderr || '')) {
  stop(`Could not ask npm. Is the internet on?\n${seen.stderr}`);
}
if (dry) {
  console.log('Rehearsal: skipping the login check.');
} else {
  const who = run('npm', ['whoami'], { capture: true, allowFail: true });
  if (who.status !== 0) stop('You are not logged in to npm. Run "npm login", then run this again.');
  console.log(`Logged in to npm as ${out(who)}.`);
}

// 3 ---------------------------------------------------------------------------------------------
say('Installing exactly what the lock files say');
run('npm', ['ci']);
run('npm', ['ci'], { cwd: cli });

// 4 ---------------------------------------------------------------------------------------------
say('Running the checks (types and tests, web app and command)');
run('npm', ['run', 'typecheck']);
run('npm', ['test']);
run('npm', ['run', 'typecheck'], { cwd: cli });
run('npm', ['test'], { cwd: cli });

// 5 ---------------------------------------------------------------------------------------------
say('Building the dashboard into the command, then the command');
run('npm', ['run', 'build:app']);
run('npm', ['run', 'build'], { cwd: cli });

// 6 ---------------------------------------------------------------------------------------------
say('Packing, and checking what would be uploaded');
const listing = run('npm', ['pack', '--dry-run', '--json'], { cwd: cli, capture: true });
let info;
try {
  const text = listing.stdout || '';
  info = JSON.parse(text.slice(text.indexOf('[')))[0];
} catch {
  stop(`Could not read the file list from npm:\n${listing.stdout}\n${listing.stderr}`);
}
const files = info.files.map((f) => f.path);
const allowedTop = new Set(['dist', 'web', 'README.md', 'LICENSE', 'package.json', 'npm-shrinkwrap.json']);
const stray = files.filter((f) => !allowedTop.has(f.split('/')[0]));
const missing = ['dist/index.js', 'web/index.html', 'web/THIRD_PARTY_NOTICES.txt', 'README.md', 'LICENSE', 'package.json', 'npm-shrinkwrap.json']
  .filter((f) => !files.includes(f));
if (stray.length) stop(`These files would be uploaded but should not be:\n  ${stray.join('\n  ')}`);
if (missing.length) stop(`These files are missing from the upload:\n  ${missing.join('\n  ')}`);
console.log(`${files.length} files, ${Math.round(info.size / 1024)} kB packed, ${Math.round(info.unpackedSize / 1024)} kB unpacked. Only dist, web, README, LICENSE, package.json and the pinned dependency list.`);

// 7 ---------------------------------------------------------------------------------------------
say('Installing the packed file in a throwaway folder and starting it');

async function smokeTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-release-'));
  let child = null;
  try {
    run('npm', ['pack', '--pack-destination', q(tmp)], { cwd: cli, capture: true });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) return 'npm pack made no .tgz file.';
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"release-smoke-test","private":true}\n');
    run('npm', ['install', '--no-audit', '--no-fund', q(path.join(tmp, tgz))], { cwd: tmp, capture: true });

    const entry = path.join(tmp, 'node_modules', pkg.name, 'dist', 'index.js');
    const ver = run(q(process.execPath), [q(entry), '--version'], { capture: true });
    if (out(ver) !== pkg.version) return `The packed command says version "${out(ver)}", expected "${pkg.version}".`;

    // Start it on any free port (0 = let the computer pick), with no Claude folder, and ask for the page like a browser would
    child = spawn(process.execPath, [entry, '--no-open', '--port', '0'], {
      cwd: tmp,
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'no-claude-folder'), LLM_USAGE_HOME: path.join(tmp, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const deadline = Date.now() + 15000;
    let port = null;
    while (Date.now() < deadline && !port) {
      await new Promise((r) => setTimeout(r, 150));
      port = /http:\/\/localhost:(\d+)\//.exec(log)?.[1] ?? null;
    }
    if (!port) return `The packed command did not start within 15 seconds. It said:\n${log}`;
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    const policy = page.headers.get('content-security-policy') || '';
    if (!page.ok || !html.includes('llm-usage-server') || !policy.includes("connect-src 'self'")) {
      return 'The packed command started, but the dashboard page or its security policy is wrong.';
    }
    console.log(`Started on port ${port}: dashboard served, security policy present, version ${pkg.version}.`);
    return null;
  } finally {
    if (child) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    // Windows can hold the folder for a moment after the program stops, so removing it is tried a few times
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
const smokeProblem = await smokeTest();
if (smokeProblem) stop(smokeProblem);

// 8 ---------------------------------------------------------------------------------------------
if (dry) {
  say('Rehearsal publish (npm publish --dry-run)');
  console.log('npm builds and tests the package once more, then stops before uploading.');
  console.log('Its "+ name@version" line and a warning about being logged in are part of a dry run. Nothing is uploaded.');
  run('npm', ['publish', '--dry-run'], { cwd: cli });
  console.log('\nRehearsal finished. NOTHING was published. Run "npm run release" to do it for real.\n');
  process.exit(0);
}

say('Publishing');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let answer = '';
try {
  answer = await rl.question(`\nPublish ${pkg.name}@${pkg.version} to npm now? This cannot be undone.\nType ${pkg.version} to confirm: `);
} catch {
  // Ctrl+C or Ctrl+D at the question
  console.log('');
  stop('Cancelled. Nothing was published.');
} finally {
  rl.close();
}
if (answer.trim() !== pkg.version) stop('Not confirmed. Nothing was published.');

run('npm', ['publish'], { cwd: cli }); // npm asks for your 2FA code here

console.log(`
Published ${pkg.name}@${pkg.version}.

Last steps (one command at a time):
  git tag v${pkg.version}
  git push origin v${pkg.version}
  npx --yes ${pkg.name}@${pkg.version} --version      (should print ${pkg.version})
`);
