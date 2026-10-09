# Security

## Reporting a problem

Please don't open a public issue that describes a security problem.

1. Use GitHub's **Report a vulnerability** button on this repository's **Security** tab
   ([direct link](https://github.com/beastllama/llm-usage-analyzer/security/advisories/new)).
2. If the button is not there, open an issue that says only "I have a security report", with no details.
   The maintainer will reply with a private way to send it.

## What we protect

- **Your usage data stays on your computer.** The command reads Claude Code's local history. It makes no network
  requests of its own: no sign-in, no API keys, no uploads, no update checks, no analytics.
- **The page the command serves** is sent with a Content-Security-Policy
  (`connect-src 'self'`, `script-src 'self'`, `object-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'`).
  This is a **second line of defence**, not a guarantee. A policy cannot stop every way a script could send data
  out (for example, by navigating the tab). The first line is that the page contains no code that sends data anywhere.
- **The local server** listens on 127.0.0.1 only, rejects Host headers that are not its own (DNS rebinding), and
  refuses requests the browser marks as cross-site. It hands your numbers only to its own page. The developer
  command `serve` additionally allows the dashboard dev ports (5173, 4173) and any origin you pass with `--origin`.
- **Files it writes** (`~/.llm-usage/*`, `usage_report.json`) are created readable by your user only, where the
  operating system supports that. `scan` warns before it writes the report into a git folder.
- **Releases** are published by hand from the maintainer's computer with npm two-factor sign-in. There is no
  automation token to steal. The command ships a pinned list of the exact versions of the packages it needs
  (`npm-shrinkwrap.json`), so a new version of a dependency cannot reach users without a new release.

## Known limits

- **While the command runs, other programs on the same computer can ask it for your numbers.** The server has no
  password: it checks where a request comes from, not who sent it. On a computer shared with people you don't
  trust, don't run it. Stop it with Ctrl+C when you are done. The numbers are token counts, model names and day
  totals. They never include your prompts or files.
- Anyone who can run programs as you can read your Claude history directly. This tool doesn't change that.
- With `serve`, any page on a dev port (5173, 4173) can read the data. Don't run untrusted code there.
- The website version, if you use one, only reads files you choose, in your browser. It cannot read your Claude Code
  history. Your files are not uploaded.
- The browser extension and key-based imports were retired. They are kept in `archive/` and are not built or supported.
