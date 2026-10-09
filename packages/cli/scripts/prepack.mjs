// Runs before `npm pack` and `npm publish`.
// 1. Stops the publish if the dashboard or the built command is missing, so a broken package never goes out.
// 2. Checks the command's first line. A Windows line ending (CR) there breaks `npx` on macOS and Linux.
// 3. Copies the README and LICENSE in, so the npm page shows them.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!fs.existsSync(here('../web/index.html'))) {
  fail('packages/cli/web/index.html is missing. Run "npm run build:app" in the repo root first.');
}

if (!fs.existsSync(here('../dist/index.js'))) {
  fail('packages/cli/dist/index.js is missing. Run "npm run build" in packages/cli first.');
}
const firstLine = fs.readFileSync(here('../dist/index.js'), 'utf8').split('\n')[0];
if (firstLine !== '#!/usr/bin/env node') {
  fail(`The first line of dist/index.js must be exactly "#!/usr/bin/env node". Found: ${JSON.stringify(firstLine)}`);
}

for (const f of ['README.md', 'LICENSE']) fs.copyFileSync(here(`../../../${f}`), here(`../${f}`));
