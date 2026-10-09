# Security

## Reporting a problem

Please don't open a public issue for a security problem.
Use GitHub's **Report a vulnerability** button on this repository's Security tab.

## What we protect

- **Your usage data.** It stays on your computer. The tool has no network features: no sign-in, no API keys, no uploads.
- **The page the CLI serves.** It is sent with a Content-Security-Policy (`connect-src 'self'`), so the browser itself blocks the page from contacting any other address.
- **The local server.** It listens on 127.0.0.1 only and rejects foreign Host headers (DNS rebinding). Other pages can read it only if they are on a dashboard dev port (5173, 4173) or an origin you add with `--origin`.
- **Other local pages.** Any page served from those dev ports can read the data. Don't run untrusted code on them.

## Known limits

- Anyone who can run programs as you on your computer can read your Claude history anyway. This tool doesn't change that.
- The browser extension and key-based imports were retired. They are kept in `archive/` and are not built or supported.
