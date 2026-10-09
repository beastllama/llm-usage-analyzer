import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://console.anthropic.com/*"],
  run_at: "document_idle"
}

interface ScrapedUsageData {
  provider: 'anthropic'
  source: 'extension'
  scrapedAt: string
  url: string
  period?: {
    start: string
    end: string
  }
  usage: {
    tokens: {
      input: number
      output: number
      cached?: number
      by_model: Record<string, { input: number; output: number }>
    }
    cost?: {
      total: number
      by_model?: Record<string, number>
    }
  }
  raw?: string
}

// Listen for scrape requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "scrapeUsage") {
    scrapeAnthropicUsage().then(sendResponse)
    return true // Keep channel open for async response
  }
})

async function scrapeAnthropicUsage(): Promise<ScrapedUsageData | { error: string }> {
  try {
    // Check if we're on a usage page
    const url = window.location.href

    if (!url.includes('console.anthropic.com')) {
      return { error: 'Not on Anthropic Console. Please navigate to console.anthropic.com' }
    }

    // Try to find usage data in the page
    const data = await extractUsageFromPage()

    if (!data) {
      return { error: 'Could not find usage data. Navigate to Settings > Usage to see your usage.' }
    }

    return data
  } catch (err) {
    return { error: `Scrape failed: ${err}` }
  }
}

async function extractUsageFromPage(): Promise<ScrapedUsageData | null> {
  // Strategy 1: Look for usage tables in the DOM
  const usageData = await extractFromDOM()
  if (usageData) return usageData

  // Strategy 2: Look for embedded JSON data
  const jsonData = await extractFromPageJSON()
  if (jsonData) return jsonData

  // Strategy 3: Check for API response data in page scripts
  const scriptData = await extractFromScripts()
  if (scriptData) return scriptData

  return null
}

async function extractFromDOM(): Promise<ScrapedUsageData | null> {
  // Look for usage metrics displayed on the page
  // Anthropic Console structure varies, so we try multiple selectors

  const usageContainer = document.querySelector('[data-testid="usage-section"]')
    || document.querySelector('.usage-summary')
    || document.querySelector('[class*="usage"]')

  if (!usageContainer) return null

  // Try to find token counts
  const tokenElements = usageContainer.querySelectorAll('[class*="token"], [class*="count"]')
  let inputTokens = 0
  let outputTokens = 0
  const byModel: Record<string, { input: number; output: number }> = {}

  tokenElements.forEach(el => {
    const text = el.textContent || ''
    const label = el.previousElementSibling?.textContent?.toLowerCase() || ''

    // Parse numbers from text (handle K, M suffixes)
    const number = parseTokenCount(text)

    if (label.includes('input') || label.includes('prompt')) {
      inputTokens += number
    } else if (label.includes('output') || label.includes('completion')) {
      outputTokens += number
    }
  })

  // Look for model-specific data
  const modelRows = usageContainer.querySelectorAll('tr, [class*="model-row"]')
  modelRows.forEach(row => {
    const cells = row.querySelectorAll('td, [class*="cell"]')
    if (cells.length >= 3) {
      const modelName = cells[0]?.textContent?.trim() || ''
      if (modelName && modelName.includes('claude')) {
        byModel[modelName] = {
          input: parseTokenCount(cells[1]?.textContent || ''),
          output: parseTokenCount(cells[2]?.textContent || '')
        }
      }
    }
  })

  // Look for date range
  const dateRange = extractDateRange()

  if (inputTokens === 0 && outputTokens === 0 && Object.keys(byModel).length === 0) {
    return null
  }

  return {
    provider: 'anthropic',
    source: 'extension',
    scrapedAt: new Date().toISOString(),
    url: window.location.href,
    period: dateRange,
    usage: {
      tokens: {
        input: inputTokens || Object.values(byModel).reduce((sum, m) => sum + m.input, 0),
        output: outputTokens || Object.values(byModel).reduce((sum, m) => sum + m.output, 0),
        by_model: byModel
      }
    },
    raw: usageContainer.innerHTML
  }
}

async function extractFromPageJSON(): Promise<ScrapedUsageData | null> {
  // Look for __NEXT_DATA__ or similar embedded JSON
  const nextDataScript = document.querySelector('script#__NEXT_DATA__')
  if (nextDataScript) {
    try {
      const pageData = JSON.parse(nextDataScript.textContent || '{}')
      const usage = findUsageInObject(pageData)
      if (usage) {
        return transformEmbeddedData(usage)
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Look for other embedded JSON patterns
  const scripts = document.querySelectorAll('script:not([src])')
  for (const script of scripts) {
    const content = script.textContent || ''
    if (content.includes('usage') || content.includes('tokens')) {
      try {
        // Try to extract JSON from script
        const match = content.match(/\{[\s\S]*"usage"[\s\S]*\}/)
        if (match) {
          const data = JSON.parse(match[0])
          const usage = findUsageInObject(data)
          if (usage) {
            return transformEmbeddedData(usage)
          }
        }
      } catch {
        // Continue to next script
      }
    }
  }

  return null
}

async function extractFromScripts(): Promise<ScrapedUsageData | null> {
  // This is a fallback - check if there's any window-level usage data
  const windowAny = window as unknown as Record<string, unknown>

  const possibleKeys = ['__USAGE_DATA__', '__APP_STATE__', 'initialState', 'pageProps']
  for (const key of possibleKeys) {
    if (windowAny[key]) {
      const usage = findUsageInObject(windowAny[key])
      if (usage) {
        return transformEmbeddedData(usage)
      }
    }
  }

  return null
}

function findUsageInObject(obj: unknown, depth = 0): unknown {
  if (depth > 10) return null // Prevent infinite recursion

  if (!obj || typeof obj !== 'object') return null

  const record = obj as Record<string, unknown>

  // Check if this object looks like usage data
  if ('tokens' in record || 'input_tokens' in record || 'usage' in record) {
    return record
  }

  // Recursively search
  for (const value of Object.values(record)) {
    const found = findUsageInObject(value, depth + 1)
    if (found) return found
  }

  return null
}

function transformEmbeddedData(data: unknown): ScrapedUsageData {
  const record = data as Record<string, unknown>

  // Handle various data shapes
  let inputTokens = 0
  let outputTokens = 0
  const byModel: Record<string, { input: number; output: number }> = {}

  if ('input_tokens' in record) {
    inputTokens = Number(record.input_tokens) || 0
  }
  if ('output_tokens' in record) {
    outputTokens = Number(record.output_tokens) || 0
  }
  if ('tokens' in record && typeof record.tokens === 'object') {
    const tokens = record.tokens as Record<string, unknown>
    inputTokens = Number(tokens.input) || inputTokens
    outputTokens = Number(tokens.output) || outputTokens
  }
  if ('by_model' in record && typeof record.by_model === 'object') {
    const models = record.by_model as Record<string, Record<string, number>>
    for (const [model, counts] of Object.entries(models)) {
      byModel[model] = {
        input: counts.input || 0,
        output: counts.output || 0
      }
    }
  }

  return {
    provider: 'anthropic',
    source: 'extension',
    scrapedAt: new Date().toISOString(),
    url: window.location.href,
    usage: {
      tokens: {
        input: inputTokens,
        output: outputTokens,
        by_model: byModel
      }
    }
  }
}

function extractDateRange(): { start: string; end: string } | undefined {
  // Look for date inputs or displayed date range
  const dateInputs = document.querySelectorAll('input[type="date"], [class*="date-picker"], [class*="calendar"]')

  if (dateInputs.length >= 2) {
    const start = (dateInputs[0] as HTMLInputElement).value
    const end = (dateInputs[1] as HTMLInputElement).value
    if (start && end) {
      return { start, end }
    }
  }

  // Try to find date text on the page
  const dateText = document.body.textContent?.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*[-–to]\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/)
  if (dateText) {
    return { start: dateText[1], end: dateText[2] }
  }

  return undefined
}

function parseTokenCount(text: string): number {
  if (!text) return 0

  // Remove commas and whitespace
  const cleaned = text.replace(/[,\s]/g, '').toLowerCase()

  // Extract number with optional suffix
  const match = cleaned.match(/([\d.]+)(k|m|b)?/)
  if (!match) return 0

  let num = parseFloat(match[1])

  switch (match[2]) {
    case 'k':
      num *= 1000
      break
    case 'm':
      num *= 1000000
      break
    case 'b':
      num *= 1000000000
      break
  }

  return Math.round(num)
}

// Auto-detect when on usage page
if (window.location.href.includes('/usage') || window.location.href.includes('/billing')) {
  console.log('[LLM Usage Analyzer] Detected usage page, ready to scrape')
}
