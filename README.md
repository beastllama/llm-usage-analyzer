# LLM Usage Analyzer

**Is your Claude subscription worth it?**
This tool compares what you pay with what the same usage would cost on pay-as-you-go. It runs on your computer.

---

## ⚡ Fastest way (2 minutes, no browser)

1. Install once (needs Node 22.12+ and Claude Code):
   ```bash
   git clone https://github.com/beastllama/llm-usage-analyzer.git
   cd llm-usage-analyzer
   npm run setup
   ```
2. Run:
   ```bash
   llm-usage scan       # reads your Claude Code history
   llm-usage analyze    # compares pay-as-you-go with each plan
   ```

That's it. Done.

---

## 🖥️ Dashboard (optional)

```bash
npm start              # starts the dashboard at http://localhost:5173 and the local server
```

Then click **Analyze My Usage** (if the local server is running) or drop in a `usage_report.json`.

The dashboard shows **one answer first**. Details are one click away.

---

## 🎯 Live limits (Pro and Max)

Anthropic does not publish exact limits. Claude Code does show your live 5-hour and weekly percentages, though. This tool can record them.

1. Add this to `~/.claude/settings.json`:
   ```json
   {
     "statusLine": { "type": "command", "command": "llm-usage statusline" }
   }
   ```
2. Use Claude Code for a few days.
3. Check whether a lower plan would have fit:
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
| `llm-usage serve` | Local server the dashboard reads from (this computer only) |

---

## 🔒 Privacy

- **Your Claude data stays on your computer.** The CLI reads `~/.claude/projects/` and never uploads it.
- **The local server listens only on 127.0.0.1.** Only the dashboard's own ports (5173 and 4173) and addresses you add with `--origin` can read it. Other pages are refused.
- **Dashboard analysis runs in your browser.**
- **Optional AI tip:** off by default. If you turn it on and paste your own Gemini key, only these numbers go to Google: your plan, estimated cost, token totals, and active days. No file text, no messages.
- **OpenAI import:** your admin key goes only to OpenAI.
- **Two outside calls:** the page loads Tailwind and the Inter font from CDNs. Those servers see your IP address, as with any website.

---

## 🧭 What the numbers mean (and don't)

✅ **Counted:**
- Each Claude reply once, even when Claude Code writes several log lines for it
- Input, output, and cache tokens, each priced at list prices
- Days by your local calendar

⚠️ **Limits of the estimate:**
- **Not exact.** List prices, not your invoice.
- **Output tokens are a lower bound.** The local logs do not record the final output count.
- **Anthropic does not publish a daily cap.** So this tool makes no "you fit in Pro" claim from message counts.
- **Claude.ai web chats are not in Claude Code logs.** Use the web export in the dashboard for those.
- **Transcripts are deleted after 30 days** by default. This tool keeps older days it has already seen in `~/.llm-usage/history.json`. Scan regularly to keep history. You can raise the limit with `cleanupPeriodDays` in Claude Code's settings.
- **Models without a known price are left out**, and the dashboard says which ones.

---

## ⚙️ Settings

| Setting | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Use a different Claude Code folder (default `~/.claude`) |
| `LLM_USAGE_HOME` | Where history and limit readings are saved (default `~/.llm-usage`) |
| `llm-usage serve --origin https://your.site` | Let another dashboard address read the local server |

---

## 🛠️ If something's off

- **"Claude Code data not found"**: use Claude Code once, or set `CLAUDE_CONFIG_DIR`.
- **"Port 3456 is already in use"**: stop the other program, or run `llm-usage serve --port 3457`.
- **Dashboard says "Disconnected"**: keep `llm-usage serve` running in a terminal.
- **"Nothing to compare yet"**: that report has no priced Claude usage. Check the file and dates.

---

## 🧑‍💻 For developers

```bash
npm run typecheck     # web app
npm test              # web app tests
npm run build         # production build

cd packages/cli
npm run typecheck && npm test && npm run build
```

Project layout:
- `App.tsx`, `components/`, `services/`: the web dashboard
- `services/pricing.ts`: all prices and plan multipliers, in one place
- `packages/cli/`: the `llm-usage` command
- `packages/extension/`: a browser extension that collects from the Anthropic and OpenAI consoles (API billing, not Pro or Max)

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Not chosen yet. Until one is added, all rights are reserved by the maintainer.
