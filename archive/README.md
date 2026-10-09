# Archive

Code kept for reference. It is not part of the product, is not built in CI, and is not supported.

## extension/ (browser extension, archived)

**Why it was archived**

- It collects from the Anthropic and OpenAI consoles, which are API billing. The product is about Claude Pro and Max subscriptions.
- It reads page HTML with class-name patterns that change without notice, and has no test fixtures.
- It asks for browser permissions (tabs, storage, context menus, notifications) for a feature that most users don't need.
- Its build framework (Plasmo) has had no release since May 2025.

**What still works**

- It builds with `npm install --ignore-scripts && npx plasmo build` in `archive/extension`.
- The popup loads in Chromium with no errors. The content scripts were not tested, because they need a logged-in console.

**To revive it**, move it back to `packages/extension`, fix the scrapers against a real console page, and add fixtures.
