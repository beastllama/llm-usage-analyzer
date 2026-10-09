# LLM Usage Analyzer

**Is your Claude subscription worth it?**
This tool compares what you pay with what the same usage would cost on pay-as-you-go. It runs on your computer.

---

## ⚡ Fastest way (one command)

```bash
npx llm-usage-analyzer
```

Your browser opens with the answer. Needs [Node 22.12+](https://nodejs.org) and Claude Code history on the same computer.
No login. No API key. Nothing to install first. (npx may ask `Ok to proceed?` the first time. Type `y`.)

**Use claude.ai in the browser, not Claude Code?** Run the same command, choose *I use claude.ai in my browser*, and drop in your chat export. Steps are on the page.

---

## 🖥️ In the terminal instead

```bash
npm install -g llm-usage-analyzer      # once

llm-usage scan                         # reads your Claude Code history, writes usage_report.json
llm-usage analyze                      # compares pay-as-you-go with each plan
```

---

## 🎯 Live limits (Pro and Max)

Anthropic does not publish exact limits. Claude Code does show your live 5-hour and weekly percentages, though. This tool can record them.

1. Install it once, so the status line starts fast: `npm install -g llm-usage-analyzer`
2. Add this to `~/.claude/settings.json`:
   ```json
   {
     "statusLine": { "type": "command", "command": "llm-usage statusline" }
   }
   ```
3. Use Claude Code for a few days.
4. Check whether a lower plan would have fit:
   ```bash
   llm-usage limits --plan max20x
   ```

---

## 📋 Commands

| Command | What it does |
|---|---|
| `llm-usage scan` | Reads Claude Code history, writes `usage_report.json` |
| `llm-usage scan --days 30` | Only the last 30 days |
| `llm-usage analyze` | Pay-as-you-go estimate vs Pro, Max 5x, Max 20x |
| `llm-usage statusline` | Claude Code status line. Shows live % and saves it |
| `llm-usage limits --plan pro` | Downgrade check from your saved readings |
| `llm-usage-analyzer` | Opens the dashboard on your own history (same as `npx llm-usage-analyzer`) |
| `llm-usage serve` | Local server only, no browser. For developing the dashboard |

---

## 🔒 Privacy

- **No login. No API keys. No accounts.** The tool never asks for one and never reads Claude's login.
- **Your Claude data stays on your computer.** The CLI reads `~/.claude/projects/` and never uploads it.
- **The browser enforces it.** The page the CLI serves carries a Content-Security-Policy with `connect-src 'self'`. Even a bug or a bad dependency could not send your data to another address, because the browser would block it.
- **The local server listens only on 127.0.0.1.** It checks the Host header, and it hands data only to its own page and to the dashboard dev ports (5173, 4173) or addresses you add with `--origin`.
- **Nothing loads from third parties.** Styles and the font are bundled.
- **Share only what you choose.** *More → Copy a question for an AI* copies numbers and plan names. You decide where to paste them.

---

## 🧭 What the numbers mean (and don't)

✅ **Counted:**
- Each Claude reply once, even when Claude Code writes several log lines for it
- Input, output, and cache tokens, each priced at list prices
- Days by your local calendar

⚠️ **Limits of the estimate:**
- **Not exact.** List prices, not your invoice.
- **Output tokens are a lower bound.** For each reply the largest count in the log is used. Some replies only log an early count, so the true output is higher.
- **Anthropic does not publish a daily cap.** So this tool makes no "you fit in Pro" claim from message counts.
- **Claude.ai web chats are not in Claude Code logs.** Use the web export in the dashboard for those.
- **Transcripts are deleted after 30 days** by default. This tool keeps older days it has already seen in `~/.llm-usage/history.json`. Scan regularly to keep history. You can raise the limit with `cleanupPeriodDays` in Claude Code's settings.
- **Models without a known price are left out**, and the dashboard says which ones.
- **Haiku 5.5 requests with a prompt over 100K tokens** are priced at the higher rate that applies to the whole request.

---

## ⚙️ Settings

| Setting | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Use a different Claude Code folder (default `~/.claude`) |
| `LLM_USAGE_HOME` | Where history and limit readings are saved (default `~/.llm-usage`) |
| `llm-usage serve --origin https://your.site` | Advanced: let a dashboard you host yourself read the local server |

---

## 🛠️ If something's off

- **"No Claude Code history found"**: use Claude Code once, or set `CLAUDE_CONFIG_DIR`. Claude.ai users: use the chat export.
- **Port busy**: the command moves to the next free port by itself. With `--port`, pick another.
- **The page says "Disconnected"**: the command stopped. Run it again.
- **"Nothing to compare yet"**: that report has no priced Claude usage. Check the file and dates.

---

## 🧑‍💻 For developers

```bash
git clone https://github.com/beastllama/llm-usage-analyzer.git
cd llm-usage-analyzer
npm run setup          # installs, bundles the dashboard into the CLI, links the commands
npm start              # dev dashboard on :5173 + local server on :3456

npm run typecheck && npm test && npm run build         # web app

cd packages/cli
npm run typecheck && npm test && npm run build         # CLI
```

Project layout:
- `App.tsx`, `components/`, `services/`: the web dashboard
- `services/pricing.ts`: all prices and plan multipliers, in one place
- `packages/cli/`: the `llm-usage-analyzer` command. It bundles the built dashboard in `packages/cli/web` (made by `npm run build:app`)
- `archive/`: retired code (browser extension, key-based imports). See `archive/README.md`

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

The page bundles open-source packages. Their licenses are in `THIRD_PARTY_NOTICES.txt`, which ships inside the npm package and is also served on the page at `/THIRD_PARTY_NOTICES.txt`.
