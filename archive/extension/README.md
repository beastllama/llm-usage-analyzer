# LLM Usage Analyzer - Browser Extension

Browser extension to collect usage data from Anthropic Console and OpenAI Platform.

## Features

- Scrape usage statistics from console.anthropic.com
- Scrape usage statistics from platform.openai.com
- Store collected data locally in browser
- Export data as JSON for the web dashboard
- Context menu integration for quick collection

## Development

```bash
# Install dependencies
npm install

# Run development server (with hot reload)
npm run dev

# Build for production
npm run build

# Package for distribution
npm run package
```

## Loading the Extension

### Chrome / Edge / Brave

1. Run `npm run dev` or `npm run build`
2. Open `chrome://extensions` (or equivalent)
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `build/chrome-mv3-dev` or `build/chrome-mv3-prod` directory

### Firefox

1. Run `npm run build -- --target=firefox-mv2`
2. Open `about:debugging`
3. Click "Load Temporary Add-on"
4. Select any file in `build/firefox-mv2-prod`

## Usage

1. Navigate to console.anthropic.com or platform.openai.com
2. Go to the Usage or Billing section
3. Click the extension icon
4. Click "Collect Usage Data"
5. Export to JSON when ready

## Architecture

```
src/
  contents/
    anthropic.ts    # Content script for Anthropic Console
    openai.ts       # Content script for OpenAI Platform
  popup/
    index.tsx       # Extension popup UI
  background/
    index.ts        # Service worker for persistence
```

## Supported Pages

- `console.anthropic.com/settings/usage`
- `console.anthropic.com/settings/billing`
- `platform.openai.com/usage`
- `platform.openai.com/organization/usage`

## Data Privacy

- All data is stored locally in your browser
- No data is sent to external servers
- You control when and how data is exported
