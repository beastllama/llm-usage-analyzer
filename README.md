# LLM Usage Analyzer

**Are your AI subscriptions worth it?**
This tool compares what you pay with what the same usage would cost on pay-as-you-go, for each of your AI coding tools, and adds it all up. It runs on your computer.

![The answer card. Sample data: "Pay-as-you-go would cost less than your Claude Pro plan", with the plan price and the estimate side by side.](https://raw.githubusercontent.com/beastllama/llm-usage-analyzer/main/docs/images/dashboard.png)

## 📌 The short version

- Run `npx llm-usage-analyzer`. Your browser shows one answer per tool, and the total.
- It reads the history Claude Code, Codex CLI and Gemini CLI keep on your computer. Cursor users drop in Cursor's usage file. Nothing is uploaded. No login, no API key.
- The answer is an estimate at list prices, not your invoice. When it can't be sure, it says so.

## 🧰 What it reads

| Tool | How | Compared with |
|---|---|---|
| Claude Code | Read from this computer | Claude Pro, Max 5x, Max 20x |
| Codex CLI | Read from this computer | ChatGPT Plus, Business, Pro ($100, $200, $500) |
| Gemini CLI | Read from this computer | No plan: since June 18, 2026 Google AI plans don't cover Gemini CLI, so it is pay-as-you-go. The page shows what it costs. |
| Cursor | You export a usage file from Cursor and drop it in | Cursor Pro, Pro+, Ultra |
| claude.ai (browser) | You export your chats and drop them in | Activity only: the export has no token counts, so it can't be priced |

ChatGPT in the browser can't be priced either: its data export has no token counts.

---

## ⚡ Fastest way (one command)

```bash
npx llm-usage-analyzer
```

Your browser opens with the answer. Needs [Node 18 or newer](https://nodejs.org) and Claude Code, Codex CLI or Gemini CLI history on the same computer.
No login. No API key. Nothing to install first. (npx may ask `Ok to proceed?` the first time. Type `y`.)
If the browser doesn't open, open the address the command prints, for example `http://localhost:3456`. Press Ctrl+C to stop it.

**Use Cursor, or claude.ai in the browser?** Run the same command, choose *I use Cursor* or *I use claude.ai in my browser*, and drop in the file. Steps are on the page.

The page needs a browser from 2024 or later (Chrome 111+, Safari 16.4+ or Firefox 128+).

---

## 🖥️ In the terminal instead

Install it once:

```bash
npm install -g llm-usage-analyzer
```

(If npm says "permission denied", see [npm's guide to that error](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). The `npx` command above needs no install.)

Then:

```bash
llm-usage-analyzer scan
llm-usage-analyzer analyze
```

`scan` reads your Claude Code, Codex CLI and Gemini CLI history and writes `usage_report.json` (one report per tool). `analyze` compares pay-as-you-go with each plan.

---

## 🎯 Live limits (Pro and Max)

Anthropic does not publish exact limits. Claude Code does show your live 5-hour and weekly percentages, though. This tool can record them.

You need Claude Code **2.1.243 or newer**, signed in with a **Pro or Max** plan. (Older versions send no readings, or readings that are out of date after a reset.)

1. Install it once, so the status line starts fast: `npm install -g llm-usage-analyzer`
2. Add this to `~/.claude/settings.json`. Claude Code has one status line, so this **replaces** any status line you already set:
   ```json
   {
     "statusLine": { "type": "command", "command": "llm-usage-analyzer statusline" }
   }
   ```
3. Use Claude Code for a few days. Readings are saved only while Claude Code is running with this status line.
4. Check whether a lower plan would have fit. Say which plan you pay for (`pro`, `max5x` or `max20x`). Pro is the lowest plan, so there is nothing below it to check:
   ```bash
   llm-usage-analyzer limits --plan max5x
   ```

---

## 📋 Commands

| Command | What it does |
|---|---|
| `npx llm-usage-analyzer` | Opens the dashboard on your own history |
| `llm-usage-analyzer scan` | Reads Claude Code, Codex CLI and Gemini CLI history, writes `usage_report.json` |
| `llm-usage-analyzer scan --days 30` | Only the last 30 days |
| `llm-usage-analyzer analyze` | Pay-as-you-go estimate vs each plan, per tool |
| `llm-usage-analyzer statusline` | Claude Code status line. Shows live % and saves it |
| `llm-usage-analyzer limits --plan max5x` | Downgrade check from your saved readings |
| `llm-usage-analyzer serve` | Local server only, no browser. For developing the dashboard |
| `llm-usage-analyzer help scan` | Help for one command |

Options go after the command: `llm-usage-analyzer scan --days 30`.

---

## 🔒 Privacy

- **No login. No API keys. No accounts.** The tool never asks for one and never reads any tool's login: it reads only the session logs listed below.
- **Your data stays on your computer.** The command reads `~/.claude/projects/`, `~/.codex/sessions/` (and `archived_sessions/`) and `~/.gemini/tmp/`, and makes no network requests of its own. The page it serves has no code that sends your data anywhere. A Cursor or claude.ai file you drop in is read in your browser.
- **While it runs, other programs on your computer can ask it for your numbers.** The server has no password. Press Ctrl+C when you are done, and don't run it on a computer you share with people you don't trust. The numbers are token counts, model names and day totals. They never include your prompts or files.
- **Nothing loads from third parties.** Styles and the font are bundled.
- **Share only what you choose.** *More → Copy for an AI* copies numbers, plan names and the names of models that have no price. You decide where to paste it.
- **Files it writes are private to your user account** (`~/.llm-usage`, and `usage_report.json` from `scan`). `scan` warns you before it writes the report into a git folder.

<details>
<summary>How the server is locked down</summary>

- It listens only on 127.0.0.1, checks the Host header, and refuses requests the browser marks as cross-site. It hands your numbers only to its own page. (`serve`, the developer command, also allows the dashboard dev ports 5173 and 4173, and any address you add with `--origin`.)
- The page it serves carries a Content-Security-Policy (`connect-src 'self'`, `script-src 'self'`). The browser then blocks the page's own requests to other addresses, and scripts that are not part of the page. This is a **second line of defence**. A policy cannot stop every possible leak, so the first line is the code itself, which you can read.

</details>

See [SECURITY.md](https://github.com/beastllama/llm-usage-analyzer/blob/main/SECURITY.md) for how to report a problem.

---

## 🧭 What the numbers mean (and don't)

**The answer is one of four:** your plan costs less · pay-as-you-go would cost less · too close to call (within $1, or 5% of the plan price) · can't say yet.

**What is counted:** each model reply once (even when a tool logs it several times), its input, output and cache tokens at the model maker's standard API list prices (Anthropic, OpenAI, Google; Cursor's own rates for Cursor's models), on your own calendar days.

**An estimate is not your invoice.** List prices were checked on 2026-10-10 and can change. Plan prices are the monthly price before tax. Annual billing costs less per month, so your own plan may cost less than shown. OpenAI notes that API prices are separate from what a ChatGPT plan includes: this tool compares cost, not what a plan lets you do.

**"At least" means the real cost is higher.** The dashboard shows the cost as "at least" when more than 5% of your replies were cut short in the log (their output is undercounted), when any of your usage is from a model with no known price, or when some logs could not be read. A cost that is "at least" can show that your plan is cheaper. It never says that pay-as-you-go is, because the real cost can only be higher.

<details>
<summary>More about what is, and is not, in the estimate</summary>

- **Left out of the estimate:** fast mode (about 2x the Opus price, and billed from usage credits on Pro and Max), the Batch discount, Priority Tier, US-only inference (1.1x), web search ($10 per 1,000 searches) and other tool fees.
- **Advisor tokens are not counted.** If you use Claude Code's experimental advisor, the advisor model's tokens are billed at its own rates and are not in the totals this tool reads.
- **Fable models are not covered by Pro limits.** Pro bills them as usage credits. On Max they can use up to 50% of the weekly limit. The estimate prices them at list rates either way.
- **Cut-short replies.** Claude Code writes a reply to its log before it has finished, and for some replies (mostly from its helper agents) never writes the final count. For each reply the largest count in the log is used, but those replies are still undercounted.
- **Cache writes are priced as logged.** A 1-hour cache write costs 2x the input price. On an API key Claude Code caches for 5 minutes by default, so a real API bill for the same work would differ.
- **Only this computer's history is counted.** The same tools on other computers or on the web, and chats in the browser, also use your plans but are not in these logs. A claude.ai chat export shows activity only. It has no prices.
- **Codex CLI:** each API response is counted once, also when a session was forked or archived. Fast mode costs more than the standard price and is shown as unpriced. Compressed session files (`.jsonl.zst`) are read on Node 22.15 or newer; on older Node they are skipped and the cost is shown as "at least".
- **Gemini CLI:** thinking tokens count as output, cached tokens at the caching price (cache storage fees are not in the logs). Gemini CLI deletes chats after 30 days by default; `llm-usage-analyzer scan` keeps the days it has seen. Some model names Gemini CLI uses have no row on Google's price page (for example older previews, and names Google reroutes to a newer model), so they are unpriced.
- **Cursor:** read from Cursor's usage export, whose format Cursor does not document. The "auto" model doesn't say which model answered, so it is never priced. Cursor's own Composer models are priced at Cursor's published rates. Requests Cursor marks "No Charge" are left out.
- **Plans have a 5-hour limit and a weekly limit, not a daily one.** Anthropic does not publish their sizes, so this tool makes no "you fit in Pro" claim from message counts.
- **Old transcripts are deleted.** By default Claude Code deletes session transcripts after 30 days (`cleanupPeriodDays` in its settings), and Gemini CLI deletes chats after 30 days. `llm-usage-analyzer scan` keeps the days it has already seen in `~/.llm-usage/` (one file per tool). The `npx` page adds those saved days to what the tools still have (unless you use `--days`), and saves nothing itself.
- **A change of time zone** is handled: days are kept per time zone, and a scan in a different zone does not count the same replies twice.
- **Models without a known price are not priced**, and the dashboard says which ones. A model newer than this tool's price table is not priced like an older model.
- **Haiku 5.5 requests with a prompt over 100K tokens** are priced at the higher rate that applies to the whole request.

</details>

---

## ⚙️ Settings

| Setting | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Use a different Claude Code folder (default `~/.claude`) |
| `CODEX_HOME` | Use a different Codex CLI folder (default `~/.codex`), as Codex itself does |
| `GEMINI_CLI_HOME` | The folder that holds Gemini CLI's `.gemini` folder (default your home folder), as Gemini CLI itself does |
| `LLM_USAGE_HOME` | Where history and limit readings are saved (default `~/.llm-usage`) |
| `llm-usage-analyzer serve --origin https://your.site` | Advanced, for developers: let a dashboard you host yourself read the local server. Only `serve` accepts it |

---

## 🛠️ If something's off

- **"No history found"**: use Claude Code, Codex CLI or Gemini CLI once, or set `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_CLI_HOME`. Cursor and claude.ai users: use the file from that service.
- **Port busy**: the command moves to the next free port by itself. With `--port`, pick another.
- **The page says "Stopped"**: the command is no longer running. Run it again.
- **The browser did not open**: open the address the command prints.
- **"Nothing to compare yet"**: that report has no priced usage. Check the file and dates.
- **`limits` says "No readings yet"**: see *Live limits* above. It needs Claude Code 2.1.243 or newer on a Pro or Max plan, with the status line set up.

---

## 🧑‍💻 For developers

```bash
git clone https://github.com/beastllama/llm-usage-analyzer.git
cd llm-usage-analyzer
npm run setup
npm start
```

`npm run setup` installs, bundles the dashboard into the CLI and links the commands. `npm start` runs the dev dashboard on :5173 and the local server on :3456.

Checks, before a pull request:

```bash
npm run typecheck && npm test && npm run build
cd packages/cli && npm run typecheck && npm test && npm run build
```

Project layout:
- `App.tsx`, `components/`, `services/`: the web dashboard
- `services/pricing.ts`: all model prices, in one place. `services/products.ts`: the plans of each product
- `packages/cli/`: the `llm-usage-analyzer` command. It bundles the built dashboard in `packages/cli/web` (made by `npm run build:app`)
- `archive/`: retired code (browser extension, key-based imports). See `archive/README.md`

See [CONTRIBUTING.md](https://github.com/beastllama/llm-usage-analyzer/blob/main/CONTRIBUTING.md) and [SECURITY.md](https://github.com/beastllama/llm-usage-analyzer/blob/main/SECURITY.md).

## License

MIT. See [LICENSE](https://github.com/beastllama/llm-usage-analyzer/blob/main/LICENSE).

LLM Usage Analyzer is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google or Cursor. Claude and Claude Code are trademarks of Anthropic PBC. Other product names are trademarks of their owners. Prices shown are public list prices and can change.

The page bundles open-source packages. Their licenses are in `THIRD_PARTY_NOTICES.txt`, which ships inside the npm package and is also served on the page at `/THIRD_PARTY_NOTICES.txt`.
