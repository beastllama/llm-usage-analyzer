import { UsageReport, StoredReport } from '../types';
import { tokenCost, costByModel } from './pricing';

const ESTIMATE_NOTE = 'Costs are estimates at list prices. Output tokens in local logs may be undercounted.';

/**
 * Export a single report to JSON
 */
export function exportToJSON(report: UsageReport, filename?: string): void {
  const json = JSON.stringify(report, null, 2);
  downloadFile(json, filename || generateFilename('json'), 'application/json');
}

/**
 * Export multiple reports to JSON
 */
export function exportReportsToJSON(reports: StoredReport[], filename?: string): void {
  const json = JSON.stringify(reports, null, 2);
  downloadFile(json, filename || `usage-reports-${formatDate(new Date())}.json`, 'application/json');
}

/**
 * Export report to CSV format
 */
export function exportToCSV(report: UsageReport, filename?: string): void {
  const csv = generateCSV(report);
  downloadFile(csv, filename || generateFilename('csv'), 'text/csv');
}

/**
 * Export daily breakdown to CSV
 */
export function exportDailyToCSV(report: UsageReport, filename?: string): void {
  const headers = ['Date', 'Replies', 'Input Tokens', 'Output Tokens', 'Total Tokens', 'Estimated Cost (USD)'];
  const reportCost = costByModel(report.usage.tokens.by_model).cost;
  const reportTokens = report.usage.tokens.input + report.usage.tokens.output;
  const rows = report.usage.messages.by_day.map(day => {
    const dayTokens = day.input + day.output;
    const cost = reportTokens > 0 ? (dayTokens / reportTokens) * reportCost : 0;
    return [day.date, day.count, day.input, day.output, dayTokens, cost.toFixed(4)];
  });

  const csv = toCsv(headers, rows);
  downloadFile(csv, filename || `daily-usage-${formatDate(new Date())}.csv`, 'text/csv');
}

/**
 * Export model breakdown to CSV
 */
export function exportModelBreakdownToCSV(report: UsageReport, filename?: string): void {
  const headers = ['Model', 'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Write Tokens', 'Estimated Cost (USD)', 'Priced'];
  const rows = Object.entries(report.usage.tokens.by_model).map(([model, tokens]) => {
    const { cost, priced } = tokenCost(model, tokens);
    return [
      model,
      tokens.input,
      tokens.output,
      tokens.cache_read || 0,
      (tokens.cache_write || 0) + (tokens.cache_write_1h || 0),
      cost.toFixed(4),
      priced ? 'yes' : 'no',
    ];
  });

  const csv = toCsv(headers, rows);
  downloadFile(csv, filename || `model-usage-${formatDate(new Date())}.csv`, 'text/csv');
}

/**
 * Generate a comprehensive CSV report
 */
function generateCSV(report: UsageReport): string {
  const lines: string[] = [];
  const { cost } = costByModel(report.usage.tokens.by_model);

  lines.push('LLM Usage Report');
  lines.push(`Provider,${csvCell(report.provider)}`);
  lines.push(`Source,${csvCell(report.source)}`);
  lines.push(`Period Start,${csvCell(report.period.start)}`);
  lines.push(`Period End,${csvCell(report.period.end)}`);
  lines.push(`Plan,${csvCell(report.plan.name)}`);
  lines.push(ESTIMATE_NOTE);
  lines.push('');

  lines.push('SUMMARY');
  lines.push(`Total Input Tokens,${report.usage.tokens.input}`);
  lines.push(`Total Output Tokens,${report.usage.tokens.output}`);
  lines.push(`Total Tokens,${report.usage.tokens.input + report.usage.tokens.output}`);
  lines.push(`Cache Tokens,${csvCell(Number(report.usage.tokens.cached) || 0)}`);
  lines.push(`Replies,${csvCell(Number(report.usage.messages.count) || 0)}`);
  lines.push(`Estimated Cost (USD),${cost.toFixed(2)}`);
  lines.push('');

  lines.push('MODEL BREAKDOWN');
  lines.push(toCsv(
    ['Model', 'Input Tokens', 'Output Tokens', 'Estimated Cost (USD)'],
    Object.entries(report.usage.tokens.by_model).map(([model, tokens]) => [
      model, tokens.input, tokens.output, tokenCost(model, tokens).cost.toFixed(4),
    ]),
  ));
  lines.push('');

  if (report.usage.messages.by_day.length > 0) {
    lines.push('DAILY BREAKDOWN');
    lines.push(toCsv(
      ['Date', 'Replies', 'Input Tokens', 'Output Tokens'],
      report.usage.messages.by_day.map(day => [day.date, day.count, day.input, day.output]),
    ));
  }

  return lines.join('\n');
}

/**
 * Export to PDF format (creates printable HTML that can be saved as PDF)
 */
export function exportToPDF(report: UsageReport): void {
  const html = generatePDFHTML(report);

  // A blob page opened with noopener cannot reach the app window
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Generate HTML for PDF export. Every user-supplied string is escaped.
 */
function generatePDFHTML(report: UsageReport): string {
  const { cost } = costByModel(report.usage.tokens.by_model);
  const totalTokens = report.usage.tokens.input + report.usage.tokens.output;
  const periodStart = escapeHtml(new Date(report.period.start).toLocaleDateString());
  const periodEnd = escapeHtml(new Date(report.period.end).toLocaleDateString());
  const providerName = escapeHtml(report.provider.charAt(0).toUpperCase() + report.provider.slice(1));
  const planName = escapeHtml(report.plan.name);

  const modelRows = Object.entries(report.usage.tokens.by_model).map(([model, tokens]) => {
    const { cost: modelCost, priced } = tokenCost(model, tokens);
    return `
        <tr>
          <td>${escapeHtml(model)}</td>
          <td class="number">${formatNumberWithCommas(tokens.input)}</td>
          <td class="number">${formatNumberWithCommas(tokens.output)}</td>
          <td class="number">${priced ? '$' + modelCost.toFixed(2) : 'not priced'}</td>
        </tr>`;
  }).join('');

  const dayRows = report.usage.messages.by_day.slice(-10).reverse().map(day => `
          <tr>
            <td>${escapeHtml(day.date)}</td>
            <td class="number">${formatNumberWithCommas(day.count)}</td>
            <td class="number">${formatNumberWithCommas(day.input)}</td>
            <td class="number">${formatNumberWithCommas(day.output)}</td>
          </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>LLM Usage Report - ${periodStart} to ${periodEnd}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.5;
      color: #1e293b;
      padding: 40px;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 { font-size: 24px; margin-bottom: 8px; }
    h2 { font-size: 18px; margin: 24px 0 12px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
    .header { margin-bottom: 32px; }
    .header-meta { color: #64748b; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 12px; color: #64748b; text-transform: uppercase; }
    .stat-value { font-size: 24px; font-weight: 600; color: #1e293b; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    th { background: #f8fafc; font-weight: 600; font-size: 12px; text-transform: uppercase; color: #64748b; }
    td { font-size: 14px; }
    .number { text-align: right; font-variant-numeric: tabular-nums; }
    .note { margin-top: 24px; font-size: 13px; color: #64748b; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; }
    .hint { background: #eef2ff; border: 1px solid #c7d2fe; color: #3730a3; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 20px; }
    @media print { body { padding: 20px; } .hint { display: none; } }
  </style>
</head>
<body>
  <p class="hint">To save this as a PDF, press Ctrl+P (Cmd+P on Mac) and choose "Save as PDF".</p>
  <div class="header">
    <h1>LLM Usage Report</h1>
    <p class="header-meta">${providerName} • ${periodStart} to ${periodEnd} • ${planName}</p>
  </div>

  <div class="grid">
    <div class="stat-card">
      <div class="stat-label">Total Tokens</div>
      <div class="stat-value">${formatNumberWithCommas(totalTokens)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Estimated Pay-as-you-go Cost</div>
      <div class="stat-value">$${cost.toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Replies</div>
      <div class="stat-value">${formatNumberWithCommas(report.usage.messages.count)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Input / Output</div>
      <div class="stat-value">${formatNumberWithCommas(report.usage.tokens.input)} / ${formatNumberWithCommas(report.usage.tokens.output)}</div>
    </div>
  </div>

  <h2>Model Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Model</th>
        <th class="number">Input</th>
        <th class="number">Output</th>
        <th class="number">Estimated Cost</th>
      </tr>
    </thead>
    <tbody>${modelRows}
    </tbody>
  </table>

  ${dayRows ? `
  <h2>Last 10 Active Days</h2>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th class="number">Replies</th>
        <th class="number">Input</th>
        <th class="number">Output</th>
      </tr>
    </thead>
    <tbody>${dayRows}
    </tbody>
  </table>` : ''}

  <p class="note">${escapeHtml(ESTIMATE_NOTE)}</p>

  <div class="footer">Generated by LLM Usage Analyzer • ${escapeHtml(new Date().toLocaleString())}</div>

</body>
</html>
`;
}

/**
 * Copy report data to clipboard
 */
export async function copyToClipboard(report: UsageReport): Promise<boolean> {
  try {
    const text = generateClipboardText(report);
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function generateClipboardText(report: UsageReport): string {
  const totalTokens = report.usage.tokens.input + report.usage.tokens.output;
  const { cost } = costByModel(report.usage.tokens.by_model);

  return `LLM Usage Report
Provider: ${report.provider}
Period: ${new Date(report.period.start).toLocaleDateString()} - ${new Date(report.period.end).toLocaleDateString()}
Plan: ${report.plan.name}

Summary:
- Total Tokens: ${formatNumberWithCommas(totalTokens)}
- Input Tokens: ${formatNumberWithCommas(report.usage.tokens.input)}
- Output Tokens: ${formatNumberWithCommas(report.usage.tokens.output)}
- Replies: ${report.usage.messages.count}
- Estimated Pay-as-you-go Cost: $${cost.toFixed(2)}

Models Used:
${Object.entries(report.usage.tokens.by_model)
  .map(([model, tokens]) => `- ${model}: ${formatNumberWithCommas(tokens.input + tokens.output)} tokens`)
  .join('\n')}

${ESTIMATE_NOTE}
`;
}

// Helper functions
function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function generateFilename(extension: string): string {
  return `usage-report-${formatDate(new Date())}.${extension}`;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Only real numbers are formatted. Anything else becomes 0, so text from a file never reaches the page. */
function formatNumberWithCommas(num: unknown): string {
  const n = Number(num);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Make one CSV cell safe for spreadsheets:
 * quote when needed, and prefix formula triggers (= + - @) so Excel does not run them.
 */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text) || text.startsWith("'")) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  return [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
}
