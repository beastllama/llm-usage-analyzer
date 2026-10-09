# Security

## Reporting a problem

Please don't open a public issue for a security problem.
Use GitHub's **Report a vulnerability** button on this repository's Security tab.

## What we protect

- **Your usage data.** It stays on your computer unless you choose to send a number (the optional AI tip).
- **Your keys.** The app bundles no API keys. The admin key for the OpenAI import is used once and never saved.
- **The local server.** It listens on 127.0.0.1 only. It accepts only allowlisted dashboard origins and rejects foreign Host headers.

## Known limits

- The dashboard loads Tailwind and the Inter font from public CDNs.
- The browser extension reads the Anthropic and OpenAI consoles. It's for API billing, not Pro or Max usage.
