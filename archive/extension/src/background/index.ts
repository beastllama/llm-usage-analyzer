// Background service worker for LLM Usage Analyzer extension

export {}

// Handle installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('[LLM Usage Analyzer] Extension installed')

  // Initialize storage
  chrome.storage.local.get(['scrapes'], (result) => {
    if (!result.scrapes) {
      chrome.storage.local.set({ scrapes: [] })
    }
  })
})

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveScrape') {
    // Save scraped data
    chrome.storage.local.get(['scrapes'], (result) => {
      const scrapes = result.scrapes || []
      const newScrape = {
        id: `scrape-${Date.now()}`,
        data: request.data,
        scrapedAt: new Date().toISOString(),
        tabUrl: sender.tab?.url
      }

      const updatedScrapes = [newScrape, ...scrapes].slice(0, 50) // Keep last 50
      chrome.storage.local.set({ scrapes: updatedScrapes }, () => {
        sendResponse({ success: true, id: newScrape.id })
      })
    })
    return true // Keep channel open for async response
  }

  if (request.action === 'getScrapes') {
    chrome.storage.local.get(['scrapes'], (result) => {
      sendResponse({ scrapes: result.scrapes || [] })
    })
    return true
  }

  if (request.action === 'clearScrapes') {
    chrome.storage.local.set({ scrapes: [] }, () => {
      sendResponse({ success: true })
    })
    return true
  }

  if (request.action === 'exportData') {
    chrome.storage.local.get(['scrapes'], (result) => {
      const scrapes = result.scrapes || []
      // Transform to UsageReport format
      const reports = scrapes.map((s: { data: unknown }) => transformToUsageReport(s.data))
      sendResponse({ reports })
    })
    return true
  }
})

// Badge to show number of saved scrapes
function updateBadge() {
  chrome.storage.local.get(['scrapes'], (result) => {
    const count = result.scrapes?.length || 0
    if (count > 0) {
      chrome.action.setBadgeText({ text: count.toString() })
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1' })
    } else {
      chrome.action.setBadgeText({ text: '' })
    }
  })
}

// Update badge on storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.scrapes) {
    updateBadge()
  }
})

// Initial badge update
updateBadge()

// Context menu for quick actions
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'llm-usage-collect',
    title: 'Collect Usage Data',
    contexts: ['page'],
    documentUrlPatterns: [
      'https://console.anthropic.com/*',
      'https://platform.openai.com/*'
    ]
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'llm-usage-collect' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'scrapeUsage' }, (response) => {
      if (response?.usage) {
        // Save the data
        chrome.storage.local.get(['scrapes'], (result) => {
          const scrapes = result.scrapes || []
          const newScrape = {
            id: `scrape-${Date.now()}`,
            data: response,
            scrapedAt: new Date().toISOString()
          }
          chrome.storage.local.set({ scrapes: [newScrape, ...scrapes].slice(0, 50) })
        })

        // Show notification
        const totalTokens = response.usage.tokens.input + response.usage.tokens.output
        showNotification(
          'Usage Data Collected',
          `${formatNumber(totalTokens)} tokens from ${response.provider}`
        )
      } else if (response?.error) {
        showNotification('Collection Failed', response.error)
      }
    })
  }
})

function showNotification(title: string, message: string) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icon.png'),
    title,
    message
  })
}

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

interface ScrapedData {
  provider: string
  usage: {
    tokens: {
      input: number
      output: number
      by_model: Record<string, { input: number; output: number }>
    }
  }
  period?: { start: string; end: string }
}

function transformToUsageReport(data: unknown) {
  const scraped = data as ScrapedData
  return {
    provider: scraped.provider,
    source: 'extension',
    period: scraped.period || {
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      end: new Date().toISOString()
    },
    plan: {
      name: scraped.provider === 'anthropic' ? 'Claude Pro' : 'OpenAI API',
      price_usd: 0,
      type: 'subscription'
    },
    usage: {
      tokens: scraped.usage.tokens,
      messages: {
        count: Math.round((scraped.usage.tokens.input + scraped.usage.tokens.output) / 500),
        by_day: []
      },
      sessions: { count: 1 }
    }
  }
}
