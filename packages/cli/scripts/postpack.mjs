// Runs after `npm pack` and `npm publish` have made the tarball. Removes what prepack.mjs put in the package folder.
// The pinned dependency list in particular must not stay: next to package.json (which also lists the build tools),
// it would make a later `npm ci` here fail.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const f of ['npm-shrinkwrap.json', 'README.md', 'LICENSE']) {
  fs.rmSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), { force: true });
}
