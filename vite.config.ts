import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const LICENSE_FILE = /^(licen[sc]e|copying)(\.(md|txt))?$/i;

/** Every license file under a folder, at most `depth` levels down, never inside node_modules. */
function nestedLicenseFiles(dir: string, depth: number): string[] {
  if (depth < 0) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...nestedLicenseFiles(full, depth - 1));
    else if (LICENSE_FILE.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * The license text of a package: the file at its root. A package that bundles other people's code (victory-vendor
 * carries copies of several d3 packages) may have no root file, only the files of the code it carries. Those are
 * included, each under its own path, because they are what the bundled code is licensed under.
 */
function licenseText(dir: string, pkg: { license?: unknown }): string {
  const root = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  if (root) return fs.readFileSync(path.join(dir, root), 'utf8').trim();

  const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
  const nested = nestedLicenseFiles(dir, 3);
  if (nested.length === 0) return `(This package ships no license file. Its package.json says: ${JSON.stringify(license)})`;
  const parts = nested.sort().map((file) => `[${path.relative(dir, file).split(path.sep).join('/')}]\n${fs.readFileSync(file, 'utf8').trim()}`);
  return `(This package has no license file of its own. Its package.json says: ${JSON.stringify(license)}.\n` +
    `It carries other packages' code, and these are their license files.)\n\n${parts.join('\n\n')}`;
}

/**
 * Writes THIRD_PARTY_NOTICES.txt next to the built page: the name, version and full license text of every
 * package that ends up in it. Their licenses ask for the notice to travel with the code.
 * Packages whose files are copied as assets (the font) are listed in `extra`.
 */
function thirdPartyNotices(extra: string[] = []): Plugin {
  return {
    name: 'third-party-notices',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        for (const id of Object.keys(item.modules)) {
          const match = id.replace(/\\/g, '/').match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
          if (match) dirs.add(match[1]);
        }
      }
      for (const name of extra) dirs.add(path.join(import.meta.dirname, 'node_modules', name));

      const entries = [...dirs].sort().map((dir) => {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
        return `${pkg.name}@${pkg.version} (${license})\n${'-'.repeat(60)}\n${licenseText(dir, pkg)}\n`;
      });

      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: `Licenses of the open-source packages included in this page.\n\n${entries.join('\n\n')}`,
      });
    },
  };
}

// No API keys are used anywhere in the browser bundle.
// The dev and preview servers listen on localhost only. Pass --host to expose them on purpose.
export default defineConfig({
  // Base path for hosting. Local dev, the CLI and Vercel use '/'. Set VITE_BASE to host under a sub-path.
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    host: 'localhost',
  },
  preview: {
    port: 4173,
    host: 'localhost',
  },
  build: {
    // One page, one script: the charts library alone is most of it, and splitting it would only add a loading state
    chunkSizeWarningLimit: 800,
  },
  plugins: [react(), tailwindcss(), thirdPartyNotices(['@fontsource-variable/inter'])],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '.'),
    },
  },
});
