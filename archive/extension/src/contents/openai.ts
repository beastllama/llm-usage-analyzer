import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://platform.openai.com/*"],
  run_at: "document_idle"
}

interface ScrapedUsageData {
  provider: 'openai'
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
    scrapeOpenAIUsage().then(sendResponse)
    return true // Keep channel open for async response
  }
})

async function scrapeOpenAIUsage(): Promise<ScrapedUsageData | { error: string }> {
  try {
    const url = window.location.href

    if (!url.includes('platform.openai.com')) {
      return { error: 'Not on OpenAI Platform. Please navigate to platform.openai.com' }
    }

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
  // Try different extraction strategies
  const domData = await extractFromDOM()
  if (domData) return domData

  const chartData = await extractFromCharts()
  if (chartData) return chartData

  return null
}

async function extractFromDOM(): Promise<ScrapedUsageData | null> {
  // OpenAI usage page typically shows costs and activity
  // Look for usage tables and statistics

  // Try to find usage container
  const usageContainer = document.querySelector('[data-testid="usage"]')
    || document.querySelector('.usage-page')
    || document.querySelector('[class*="usage"]')
    || document.querySelector('main')

  if (!usageContainer) return null

  // Look for cost/token displays
  const byModel: Record<string, { input: number; output: number }> = {}
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCost = 0

  // Try to find model breakdown table
  const rows = usageContainer.querySelectorAll('table tr, [role="row"]')

  rows.forEach(row => {
    const cells = row.querySelectorAll('td, [role="cell"]')
    if (cells.length >= 2) {
      const modelName = cells[0]?.textContent?.trim() || ''

      // Check if this looks like a model name
      if (modelName.includes('gpt') || modelName.includes('text-') || modelName.includes('davinci') || modelName.includes('turbo')) {
        // Try to extract token counts
        const tokens = extractTokensFromRow(row)
        if (tokens) {
          byModel[modelName] = tokens
          totalInputTokens += tokens.input
          totalOutputTokens += tokens.output
        }
      }
    }
  })

  // Look for total cost display
  const costElements = usageContainer.querySelectorAll('[class*="cost"], [class*="total"], [class*="amount"]')
  costElements.forEach(el => {
    const text = el.textContent || ''
    const match = text.match(/\$?([\d,]+\.?\d*)/)
    if (match) {
      const cost = parseFloat(match[1].replace(/,/g, ''))
      if (cost > totalCost) {
        totalCost = cost
      }
    }
  })

  // Extract date range if visible
  const dateRange = extractDateRange()

  if (Object.keys(byModel).length === 0 && totalInputTokens === 0) {
    return null
  }

  return {
    provider: 'openai',
    source: 'extension',
    scrapedAt: new Date().toISOString(),
    url: window.location.href,
    period: dateRange,
    usage: {
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        by_model: byModel
      },
      cost: totalCost > 0 ? { total: totalCost } : undefined
    }
  }
}

async function extractFromCharts(): Promise<ScrapedUsageData | null> {
  // OpenAI often displays usage in charts
  // Try to extract data from chart libraries (Recharts, Chart.js, etc.)

  // Look for SVG charts
  const charts = document.querySelectorAll('svg[class*="chart"], [class*="recharts"]')

  if (charts.length === 0) return null

  // Try to find data attributes or nearby data
  for (const chart of charts) {
    const container = chart.closest('[class*="usage"], [class*="chart-container"]')
    if (container) {
      // Look for legend or tooltips with data
      const dataPoints = container.querySelectorAll('[class*="legend-item"], [class*="tooltip"]')
      const byModel: Record<string, { input: number; output: number }> = {}

      dataPoints.forEach(el => {
        const text = el.textContent || ''
        const modelMatch = text.match(/(gpt-[\w.-]+|text-[\w.-]+)/i)
        const tokenMatch = text.match(/([\d,]+)\s*(?:tokens?|input|output)/i)

        if (modelMatch && tokenMatch) {
          const model = modelMatch[1]
          const tokens = parseInt(tokenMatch[1].replace(/,/g, ''))

          if (!byModel[model]) {
            byModel[model] = { input: 0, output: 0 }
          }

          if (text.toLowerCase().includes('input') || text.toLowerCase().includes('prompt')) {
            byModel[model].input += tokens
          } else {
            byModel[model].output += tokens
          }
        }
      })

      if (Object.keys(byModel).length > 0) {
        return {
          provider: 'openai',
          source: 'extension',
          scrapedAt: new Date().toISOString(),
          url: window.location.href,
          usage: {
            tokens: {
              input: Object.values(byModel).reduce((sum, m) => sum + m.input, 0),
              output: Object.values(byModel).reduce((sum, m) => sum + m.output, 0),
              by_model: byModel
            }
          }
        }
      }
    }
  }

  return null
}

function extractTokensFromRow(row: Element): { input: number; output: number } | null {
  const text = row.textContent || ''

  // Try various patterns
  const inputMatch = text.match(/(\d[\d,]*)\s*(?:input|prompt|in)/i)
  const outputMatch = text.match(/(\d[\d,]*)\s*(?:output|completion|out)/i)

  // Or just numbers in sequence
  const numbers = text.match(/\d[\d,]*/g)?.map(n => parseInt(n.replace(/,/g, ''))) || []

  if (inputMatch || outputMatch) {
    return {
      input: inputMatch ? parseInt(inputMatch[1].replace(/,/g, '')) : 0,
      output: outputMatch ? parseInt(outputMatch[1].replace(/,/g, '')) : 0
    }
  }

  // If we have at least 2 numbers, assume first is input, second is output
  if (numbers.length >= 2) {
    return {
      input: numbers[0],
      output: numbers[1]
    }
  }

  return null
}

function extractDateRange(): { start: string; end: string } | undefined {
  // Look for date picker or displayed date range
  const dateInputs = document.querySelectorAll('input[type="date"], [aria-label*="date"], [class*="date-picker"]')

  if (dateInputs.length >= 2) {
    const start = (dateInputs[0] as HTMLInputElement).value
    const end = (dateInputs[1] as HTMLInputElement).value
    if (start && end) {
      return { start, end }
    }
  }

  // Try to find date range in text
  const monthNames = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
  const datePattern = new RegExp(`(${monthNames})\\s*\\d{1,2},?\\s*\\d{4}\\s*[-–to]+\\s*(${monthNames})\\s*\\d{1,2},?\\s*\\d{4}`, 'i')

  const body = document.body.textContent || ''
  const match = body.match(datePattern)
  if (match) {
    return { start: match[0].split(/[-–to]+/)[0].trim(), end: match[0].split(/[-–to]+/)[1].trim() }
  }

  return undefined
}

// Auto-detect when on usage page
if (window.location.href.includes('/usage') || window.location.href.includes('/organization/usage')) {
  console.log('[LLM Usage Analyzer] Detected OpenAI usage page, ready to scrape')
}
