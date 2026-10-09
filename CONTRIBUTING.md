# Contributing

Thanks for helping! This tool answers one question for Claude users: **is my subscription worth it?**

## 🚀 Setup

```bash
git clone https://github.com/beastllama/llm-usage-analyzer.git
cd llm-usage-analyzer
npm run setup        # installs everything, bundles the dashboard into the CLI, links the commands
npm start            # dev dashboard on localhost:5173 + local server on localhost:3456
npx llm-usage-analyzer --no-open   # (after setup) the bundled version, as users get it
```

Needs Node 22.12+.

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
| `components/AnalysisDashboard.tsx` | The main screen. One answer first, details behind a click. |
| `packages/cli/src/parsers/claude.ts` | Reads Claude Code transcripts. Counts each reply once. |
| `packages/cli/src/limits.ts` | Status-line readings and the downgrade check |
| `packages/cli/src/commands/serve.ts` | Local server. Serves the bundled dashboard with its security policy |
| `packages/cli/src/pricing.ts` | CLI copy of `services/pricing.ts`. A test fails if they differ. |
| `archive/` | Retired code, not built or supported. See `archive/README.md`. |

## 📐 Rules we keep

- **Never guess.** If a price, limit, or model is unknown, show "unpriced" or "not published." Don't fill the gap.
- **Plain language.** Short sentences. One primary action per screen.
- **Private by default.** The app makes no network calls and asks for no login or key. Don't add any. The served page's policy (`connect-src 'self'`) would block them anyway.
- **Cite the source.** New prices or plan facts need a link to the official page in the PR.

## 📦 Releasing (maintainers)

1. Raise `version` in `packages/cli/package.json`, merge to `main`.
2. Actions → **Publish to npm** → Run workflow. (Or push a tag that matches, like `v1.2.1`.)
3. One-time: the `NPM_TOKEN` repository secret (an npm automation token).
4. Pages: Settings → Pages → Source: **GitHub Actions**. Then Actions → **Deploy dashboard** → Re-run.

## 🐛 Reporting bugs

Include: your OS, Node version, which command or screen, and the exact message. Don't attach real usage reports. They contain your activity.

## 🔐 Security

Report security problems privately. See [SECURITY.md](SECURITY.md).

## 💡 Good first issues

- Add a test for a formatter in `services/exportService.ts`
- Improve an error message in `services/fileImport.ts`
- Add a model to `services/pricing.ts`, with its source link
- Make a screen work with the keyboard only, and say what you tested
