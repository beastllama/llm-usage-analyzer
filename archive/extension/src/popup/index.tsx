import { useState, useEffect } from "react"

interface ScrapedData {
  provider: string
  source: string
  scrapedAt: string
  url: string
  period?: { start: string; end: string }
  usage: {
    tokens: {
      input: number
      output: number
      cached?: number
      by_model: Record<string, { input: number; output: number }>
    }
    cost?: { total: number }
  }
}

interface StoredScrape {
  id: string
  data: ScrapedData
  scrapedAt: string
}

function IndexPopup() {
  const [status, setStatus] = useState<'idle' | 'scraping' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [currentTab, setCurrentTab] = useState<chrome.tabs.Tab | null>(null)
  const [scrapes, setScrapes] = useState<StoredScrape[]>([])
  const [lastScrape, setLastScrape] = useState<ScrapedData | null>(null)

  useEffect(() => {
    // Get current tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        setCurrentTab(tabs[0])
      }
    })

    // Load saved scrapes
    chrome.storage.local.get(['scrapes'], (result) => {
      if (result.scrapes) {
        setScrapes(result.scrapes)
      }
    })
  }, [])

  const isValidPage = currentTab?.url?.includes('console.anthropic.com') ||
    currentTab?.url?.includes('platform.openai.com')

  const handleScrape = async () => {
    if (!currentTab?.id) {
      setStatus('error')
      setMessage('No active tab found')
      return
    }

    setStatus('scraping')
    setMessage('Collecting usage data...')

    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'scrapeUsage' })

      if (response?.error) {
        setStatus('error')
        setMessage(response.error)
        return
      }

      if (response?.usage) {
        setStatus('success')
        setLastScrape(response as ScrapedData)

        // Save to storage
        const newScrape: StoredScrape = {
          id: `scrape-${Date.now()}`,
          data: response,
          scrapedAt: new Date().toISOString()
        }

        const updatedScrapes = [newScrape, ...scrapes].slice(0, 20) // Keep last 20
        setScrapes(updatedScrapes)
        chrome.storage.local.set({ scrapes: updatedScrapes })

        const totalTokens = response.usage.tokens.input + response.usage.tokens.output
        setMessage(`Collected ${formatNumber(totalTokens)} tokens from ${response.provider}`)
      } else {
        setStatus('error')
        setMessage('No usage data found on this page')
      }
    } catch (err) {
      setStatus('error')
      setMessage('Failed to communicate with page. Try refreshing.')
    }
  }

  const handleExport = () => {
    if (scrapes.length === 0) {
      setMessage('No data to export')
      return
    }

    // Convert scrapes to UsageReport format for the dashboard
    const reports = scrapes.map(s => transformToUsageReport(s.data))

    const blob = new Blob([JSON.stringify(reports, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = `llm-usage-export-${new Date().toISOString().split('T')[0]}.json`
    a.click()

    URL.revokeObjectURL(url)
    setMessage('Exported to file!')
  }

  const handleClear = () => {
    setScrapes([])
    setLastScrape(null)
    chrome.storage.local.remove(['scrapes'])
    setMessage('Data cleared')
  }

  const openDashboard = () => {
    // Open the web dashboard in a new tab
    chrome.tabs.create({ url: 'https://llm-usage-analyzer.vercel.app' })
  }

  return (
    <div style={{
      width: '340px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: '#0f172a',
      color: '#e2e8f0',
      padding: '16px'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <div style={{
          width: '32px',
          height: '32px',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6, #ec4899)',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '16px'
        }}>
          📊
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>LLM Usage Analyzer</h1>
          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8' }}>Collect usage data from AI platforms</p>
        </div>
      </div>

      {/* Current Page Status */}
      <div style={{
        backgroundColor: isValidPage ? '#1e3a5f' : '#3b2b3d',
        borderRadius: '8px',
        padding: '12px',
        marginBottom: '12px',
        fontSize: '13px'
      }}>
        {isValidPage ? (
          <div style={{ color: '#60a5fa' }}>
            ✓ Ready to collect from {currentTab?.url?.includes('anthropic') ? 'Anthropic Console' : 'OpenAI Platform'}
          </div>
        ) : (
          <div style={{ color: '#f472b6' }}>
            Navigate to console.anthropic.com or platform.openai.com to collect data
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <button
          onClick={handleScrape}
          disabled={!isValidPage || status === 'scraping'}
          style={{
            flex: 1,
            padding: '10px 16px',
            backgroundColor: isValidPage ? '#6366f1' : '#334155',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 500,
            cursor: isValidPage ? 'pointer' : 'not-allowed',
            opacity: status === 'scraping' ? 0.7 : 1
          }}
        >
          {status === 'scraping' ? 'Collecting...' : 'Collect Usage Data'}
        </button>
      </div>

      {/* Status Message */}
      {message && (
        <div style={{
          padding: '10px',
          backgroundColor: status === 'error' ? '#3b2b3d' : status === 'success' ? '#1e3a5f' : '#1e293b',
          borderRadius: '6px',
          fontSize: '12px',
          marginBottom: '12px',
          color: status === 'error' ? '#f472b6' : status === 'success' ? '#60a5fa' : '#94a3b8'
        }}>
          {message}
        </div>
      )}

      {/* Last Scrape Summary */}
      {lastScrape && (
        <div style={{
          backgroundColor: '#1e293b',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '12px'
        }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>
            Latest Collection
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
            <div>
              <div style={{ color: '#64748b' }}>Input Tokens</div>
              <div style={{ fontWeight: 600 }}>{formatNumber(lastScrape.usage.tokens.input)}</div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>Output Tokens</div>
              <div style={{ fontWeight: 600 }}>{formatNumber(lastScrape.usage.tokens.output)}</div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>Models</div>
              <div style={{ fontWeight: 600 }}>{Object.keys(lastScrape.usage.tokens.by_model).length || 'N/A'}</div>
            </div>
            <div>
              <div style={{ color: '#64748b' }}>Provider</div>
              <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{lastScrape.provider}</div>
            </div>
          </div>
        </div>
      )}

      {/* Saved Data */}
      {scrapes.length > 0 && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '12px', color: '#94a3b8', fontWeight: 500 }}>
              Collected Data ({scrapes.length})
            </h3>
            <button
              onClick={handleClear}
              style={{
                background: 'none',
                border: 'none',
                color: '#f472b6',
                fontSize: '11px',
                cursor: 'pointer'
              }}
            >
              Clear All
            </button>
          </div>
          <div style={{ maxHeight: '120px', overflowY: 'auto' }}>
            {scrapes.slice(0, 5).map((scrape) => (
              <div
                key={scrape.id}
                style={{
                  padding: '8px',
                  backgroundColor: '#1e293b',
                  borderRadius: '4px',
                  marginBottom: '4px',
                  fontSize: '11px'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ textTransform: 'capitalize' }}>{scrape.data.provider}</span>
                  <span style={{ color: '#64748b' }}>
                    {formatNumber(scrape.data.usage.tokens.input + scrape.data.usage.tokens.output)} tokens
                  </span>
                </div>
                <div style={{ color: '#64748b', fontSize: '10px' }}>
                  {new Date(scrape.scrapedAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Export / Dashboard */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={handleExport}
          disabled={scrapes.length === 0}
          style={{
            flex: 1,
            padding: '8px',
            backgroundColor: '#334155',
            color: scrapes.length === 0 ? '#64748b' : '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '12px',
            cursor: scrapes.length === 0 ? 'not-allowed' : 'pointer'
          }}
        >
          Export JSON
        </button>
        <button
          onClick={openDashboard}
          style={{
            flex: 1,
            padding: '8px',
            backgroundColor: '#334155',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '12px',
            cursor: 'pointer'
          }}
        >
          Open Dashboard
        </button>
      </div>

      {/* Footer */}
      <div style={{ marginTop: '12px', textAlign: 'center', fontSize: '10px', color: '#475569' }}>
        Data stored locally • Not sent to any server
      </div>
    </div>
  )
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K'
  }
  return num.toString()
}

function transformToUsageReport(data: ScrapedData) {
  // Transform scraped data to match the dashboard's UsageReport format
  return {
    provider: data.provider,
    source: 'extension',
    period: data.period || {
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      end: new Date().toISOString()
    },
    plan: {
      name: data.provider === 'anthropic' ? 'Claude Pro' : 'OpenAI API',
      price_usd: 0,
      type: 'subscription' as const
    },
    usage: {
      tokens: {
        input: data.usage.tokens.input,
        output: data.usage.tokens.output,
        cached: data.usage.tokens.cached || 0,
        by_model: data.usage.tokens.by_model
      },
      messages: {
        count: Math.round((data.usage.tokens.input + data.usage.tokens.output) / 500), // Estimate
        by_day: []
      },
      sessions: {
        count: 1
      }
    }
  }
}

export default IndexPopup
