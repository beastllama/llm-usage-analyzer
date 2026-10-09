// Runs before `npm pack` and `npm publish`.
// 1. Stops the publish if the dashboard was not bundled, so a broken package never goes out.
// 2. Copies the README and LICENSE in, so the npm page shows them.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

if (!fs.existsSync(here('../web/index.html'))) {
  console.error('packages/cli/web/index.html is missing. Run "npm run build:app" in the repo root first.');
  process.exit(1);
}
for (const f of ['README.md', 'LICENSE']) fs.copyFileSync(here(`../../../${f}`), here(`../${f}`));
