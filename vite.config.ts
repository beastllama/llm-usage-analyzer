import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
        const licenseFile = fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
        const text = licenseFile
          ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim()
          : `(This package ships no license file. Its package.json says: ${JSON.stringify(pkg.license)})`;
        const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
        return `${pkg.name}@${pkg.version} (${license})\n${'-'.repeat(60)}\n${text}\n`;
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
  plugins: [react(), tailwindcss(), thirdPartyNotices(['@fontsource-variable/inter'])],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '.'),
    },
  },
});
