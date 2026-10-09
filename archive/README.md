# Archive

Code kept for reference. It is not part of the product, is not built in CI, and is not supported.

## extension/ (browser extension, archived)

> **Archived. Not supported.** It was written against `console.anthropic.com`, which now redirects to `platform.claude.com`.

**Why it was archived**

- It collects from the Anthropic and OpenAI consoles, which are API billing. The product is about Claude Pro and Max subscriptions.
- It reads page HTML with class-name patterns that change without notice, and has no test fixtures.
- It asks for browser permissions (tabs, storage, context menus, notifications) for a feature that most users don't need.
- Its build framework (Plasmo) has had no release since May 2025.

**What still works**

- It builds with `npm install --ignore-scripts && npx plasmo build` in `archive/extension`.
- The popup loads in Chromium with no errors. The content scripts were not tested, because they need a logged-in console.

**To revive it**, move it back to `packages/extension`, fix the scrapers against a real console page, and add fixtures.

## key-based-imports/ (retired)

An OpenAI usage import and a Gemini "tip" feature. Both asked the user to paste an API key into the page.

**Why they were retired**

- The product is simple and key-free: one command, no login.
- OpenAI's usage data needs an organization **admin** key. We found no login-based route for it.
- Gemini's sign-in route would need its own Google Cloud project and consent screen. Not worth it for a tip.
- Anthropic's terms do not let third-party tools offer Claude.ai login or route requests through Free, Pro, or Max plan credentials (see https://code.claude.com/docs/en/legal-and-compliance), so there is no sign-in route for Claude either.

**To revive them**, move the files back into `services/` and `tests/`, add `@google/genai` for the Gemini one, and re-add the UI. Note the web page's policy `connect-src 'self'` (CLI-served mode) would block them.
