# Security

## Reporting a problem

Please don't open a public issue for a security problem.
Use GitHub's **Report a vulnerability** button on this repository's Security tab.

## What we protect

- **Your usage data.** It stays on your computer unless you choose to send a number (the optional AI tip).
- **Your keys.** The app bundles no API keys. The admin key for the OpenAI import is used once and never saved.
- **The local server.** It listens on 127.0.0.1 only. It answers only the dashboard's own ports (5173 and 4173) plus any origin you add with `--origin`, and rejects foreign Host headers.
- **Other local pages.** Any page served from those dashboard ports can read the data. Don't run untrusted code on them.

## Known limits

- The browser extension reads the Anthropic and OpenAI consoles. It's for API billing, not Pro or Max usage.
