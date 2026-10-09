# Contributing

Thanks for helping! This tool answers one question for Claude users: **is my subscription worth it?**

## 🚀 Setup

```bash
git clone https://github.com/beastllama/llm-usage-analyzer.git
cd llm-usage-analyzer
npm run setup        # installs everything, bundles the dashboard into the CLI, links the commands
npm start            # dev dashboard on localhost:5173 + local server on localhost:3456
llm-usage-analyzer --no-open   # (after setup) the bundled version from your checkout, as users get it
```

Needs Node 22.12+ to build the dashboard. The published command itself runs on Node 18 and newer, and CI tests it on 18, 20, 22 and 24.

## ✅ Before you open a PR

```bash
npm run typecheck && npm test && npm run build
cd packages/cli && npm run typecheck && npm test && npm run build
```

CI runs the same checks on every pull request.

## 🧭 Where things live

| Path | What's there |
|---|---|
| `services/pricing.ts` | **All prices and plan multipliers.** Change prices here only. |
| `services/analysisService.ts` | Monthly estimate, verdict, usage pattern |
| `services/estimate.ts` | When the estimate is a minimum, and what the answer may say |
| `components/AnalysisDashboard.tsx` | The main screen. One answer first, details behind a click. |
| `packages/cli/src/parsers/claude.ts` | Reads Claude Code transcripts. Counts each reply once. |
| `packages/cli/src/limits.ts` | Status-line readings and the downgrade check |
| `packages/cli/src/commands/serve.ts` | Local server. Serves the bundled dashboard with its security policy |
| `packages/cli/src/pricing.ts`, `estimate.ts` | CLI copies of the two files above. A test fails if they differ. Run `npm run sync:pricing` to update them. |
| `vercel.json` | Headers for the hosted page. A test checks its policy matches the command's. |
| `archive/` | Retired code, not built or supported. See `archive/README.md`. |

## 📐 Rules we keep

- **Never guess.** If a price, limit, or model is unknown, show "unpriced" or "not published." Don't fill the gap.
- **Plain language.** Short sentences. One primary action per screen.
- **Private by default.** The app makes no network calls except to the local analyzer, and asks for no login or key. Don't add any. The served page's policy (`connect-src 'self'`) is a second line of defence, not a reason to be careless.
- **Cite the source.** New prices or plan facts need a link to the official page in the PR.

## 📦 Releasing (maintainers)

Publishing is done by hand from your own computer. No GitHub Actions, no stored token.

1. Raise `version` in `packages/cli/package.json`. Merge to `main`.
2. `git checkout main && git pull && npm install`
3. `npm login` (once; npm asks for your 2FA code)
4. `npm run release:rehearse` runs every check and a dry-run publish. Nothing is uploaded.
5. `npm run release` runs the same checks, asks you to type the version to confirm, then publishes (npm asks for your 2FA code).
6. Mark the release: `git tag v1.2.1 && git push origin v1.2.1` (the script prints the exact line).

The script stops at the first problem and says what to do. It checks, in order: you are on `main`, with nothing uncommitted, the same as GitHub; the version is new on npm; install, types, tests; build; the exact list of files in the package; and that the packed file installs in a throwaway folder and starts.

Dependencies of the command are pinned in `packages/cli/npm-shrinkwrap.json`, and it ships in the package. To update them: `cd packages/cli && npm update`, run the checks, commit the changed `npm-shrinkwrap.json`.

The demo site is a Vercel project linked to this repo. It redeploys on every push to `main`.

## 🐛 Reporting bugs

Include: your OS, Node version, which command or screen, and the exact message. Don't attach real usage reports. They contain your activity.

## 🔐 Security

Report security problems privately. See [SECURITY.md](SECURITY.md).

## 💡 Good first issues

- Add a test for a formatter in `services/exportService.ts`
- Improve an error message in `services/fileImport.ts`
- Add a model to `services/pricing.ts`, with its source link
- Make a screen work with the keyboard only, and say what you tested
