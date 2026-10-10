import { UsageReport } from '../types';
import { tokenCost, PRICES_CHECKED } from './pricing';
import { productOf } from './products';
import { calculateAnalysis } from './analysisService';
import { describeAnswer, planLabel } from './answer';
import { formatCount, formatUsd, plain } from './format';

/** What the numbers are, and what they leave out. The limits sentence is the report's product's own. */
const estimateNote = (report: UsageReport): string =>
  `Estimates at standard list prices, checked ${PRICES_CHECKED}. Costs include cached text. Output counts in local logs can be too low. ` +
  (productOf(report)?.limitsNote ?? 'Plans also differ in how much you can use.');

/** `assumed` marks a plan the person never chose, so a file does not state it as fact. */
export interface ExportOptions {
  assumed?: boolean;
  filename?: string;
}

const DEMO_NOTE = 'Sample data, not real usage.';

/** The pay-as-you-go cost of the period as text: "$12.34", "at least $12.34", or "not priced". */
function costText(report: UsageReport, plan: string): string {
  const cmp = calculateAnalysis(report, plan);
  if (!cmp.canJudge) return 'not priced';
  return `${cmp.lowerBound ? 'at least ' : ''}${formatUsd(cmp.apiCostPeriod)}`;
}

/** Export a report as JSON. Returns the file name, so the screen can say where it went. */
export function exportToJSON(report: UsageReport, filename?: string): string {
  const name = filename || generateFilename('json');
  downloadFile(JSON.stringify(report, null, 2), name, 'application/json');
  return name;
}

/** Export a report as a CSV file that opens in a spreadsheet. */
export function exportToCSV(report: UsageReport, plan: string, options: ExportOptions = {}): string {
  const name = options.filename || generateFilename('csv');
  downloadFile(generateCSV(report, plan, options.assumed ?? false), name, 'text/csv');
  return name;
}

/** The text of the CSV file. */
export function generateCSV(report: UsageReport, plan: string, assumed = false): string {
  const lines: string[] = [];
  const cmp = calculateAnalysis(report, plan);
  const answer = describeAnswer(cmp);

  lines.push('LLM Usage Report');
  if (report.source === 'demo') lines.push(DEMO_NOTE);
  if (report.tool) lines.push(`Tool,${csvCell(report.tool)}`);
  lines.push(`Period Start,${csvCell(report.period.start)}`);
  lines.push(`Period End,${csvCell(report.period.end)}`);
  lines.push(`Plan,${csvCell(cmp.payAsYouGo ? 'None (pay-as-you-go)' : cmp.planKey ? planLabel(cmp.planKey, assumed) : 'None')}`);
  if (cmp.canJudge) {
    lines.push(`Answer,${csvCell(answer.headline)}`);
    lines.push(`Detail,${csvCell(answer.detail)}`);
    for (const caveat of answer.caveats) lines.push(`Note,${csvCell(caveat)}`);
  }
  lines.push(csvCell(estimateNote(report)));
  lines.push('');

  lines.push('SUMMARY');
  lines.push(`Total Input Tokens,${report.usage.tokens.input}`);
  lines.push(`Total Output Tokens,${report.usage.tokens.output}`);
  lines.push(`Total Tokens,${report.usage.tokens.input + report.usage.tokens.output}`);
  lines.push(`Cache Tokens,${Number(report.usage.tokens.cached) || 0}`);
  lines.push(`Replies,${Number(report.usage.messages.count) || 0}`);
  lines.push(`Pay-as-you-go for this period (USD),${csvCell(costText(report, plan).replace('$', ''))}`);
  lines.push('');

  lines.push('MODEL BREAKDOWN');
  lines.push(toCsv(
    ['Model', 'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Write Tokens', 'Estimated Cost (USD)'],
    Object.entries(report.usage.tokens.by_model).map(([model, tokens]) => {
      const { cost, priced } = tokenCost(model, tokens);
      return [
        plain(model), tokens.input, tokens.output, tokens.cache_read || 0,
        (tokens.cache_write || 0) + (tokens.cache_write_1h || 0),
        priced ? cost.toFixed(4) : 'not priced',
      ];
    }),
  ));
  lines.push('');

  if (report.usage.messages.by_day.length > 0) {
    lines.push('DAILY BREAKDOWN');
    lines.push(toCsv(
      ['Date', 'Replies', 'Input Tokens', 'Output Tokens'],
      report.usage.messages.by_day.map((day) => [day.date, day.count, day.input, day.output]),
    ));
  }

  return lines.join('\n');
}

/** Open a printable page. The browser's print dialog can save it as a PDF. */
export function exportToPDF(report: UsageReport, plan: string, assumed = false): void {
  const html = generatePDFHTML(report, plan, assumed);

  // A blob page opened with noopener cannot reach the app window
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Generate HTML for the printable page. Every string that came from a file is cleaned and escaped. */
export function generatePDFHTML(report: UsageReport, plan: string, assumed = false): string {
  const cmp = calculateAnalysis(report, plan);
  const answer = describeAnswer(cmp);
  const totalTokens = report.usage.tokens.input + report.usage.tokens.output;
  const periodStart = escapeHtml(new Date(report.period.start).toLocaleDateString());
  const periodEnd = escapeHtml(new Date(report.period.end).toLocaleDateString());

  const modelRows = Object.entries(report.usage.tokens.by_model).map(([model, tokens]) => {
    const { cost, priced } = tokenCost(model, tokens);
    return `
        <tr>
          <td>${escapeHtml(plain(model))}</td>
          <td class="number">${formatNumberWithCommas(tokens.input)}</td>
          <td class="number">${formatNumberWithCommas(tokens.output)}</td>
          <td class="number">${priced ? formatUsd(cost) : 'not priced'}</td>
        </tr>`;
  }).join('');

  const dayRows = report.usage.messages.by_day.filter((d) => d.count > 0).slice(-10).reverse().map((day) => `
          <tr>
            <td>${escapeHtml(day.date)}</td>
            <td class="number">${formatNumberWithCommas(day.count)}</td>
            <td class="number">${formatNumberWithCommas(day.input)}</td>
            <td class="number">${formatNumberWithCommas(day.output)}</td>
          </tr>`).join('');

  const answerBlock = cmp.canJudge ? `
  <div class="answer">
    <div class="stat-label">Your answer (${escapeHtml(cmp.payAsYouGo ? 'pay-as-you-go' : cmp.planKey ? planLabel(cmp.planKey, assumed) : 'no plan')})</div>
    <div class="answer-headline">${escapeHtml(answer.headline)}</div>
    <div>${escapeHtml(answer.detail)}</div>
    ${answer.caveats.map((c) => `<div class="caveat">${escapeHtml(c)}</div>`).join('')}
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
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
    .header { margin-bottom: 24px; }
    .header-meta { color: #475569; font-size: 14px; }
    .answer { background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .answer-headline { font-size: 20px; font-weight: 600; margin: 4px 0; }
    .caveat { color: #92400e; font-size: 13px; margin-top: 6px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 12px; color: #475569; text-transform: uppercase; }
    .stat-value { font-size: 24px; font-weight: 600; color: #1e293b; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    th { background: #f8fafc; font-weight: 600; font-size: 12px; text-transform: uppercase; color: #475569; }
    td { font-size: 14px; }
    .number { text-align: right; font-variant-numeric: tabular-nums; }
    .note { margin-top: 24px; font-size: 13px; color: #475569; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; }
    .hint { background: #eef2ff; border: 1px solid #c7d2fe; color: #3730a3; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 20px; }
    @media print { body { padding: 20px; } .hint { display: none; } }
  </style>
</head>
<body>
  <p class="hint">To save this as a PDF, print the page (Ctrl+P, or Cmd+P on a Mac) and choose "Save as PDF".</p>
  <div class="header">
    <h1>LLM Usage Report</h1>
    <p class="header-meta">${report.tool ? escapeHtml(plain(report.tool)) + ' • ' : ''}${periodStart} to ${periodEnd}${report.source === 'demo' ? ' • ' + DEMO_NOTE : ''}</p>
  </div>
  ${answerBlock}
  <div class="grid">
    <div class="stat-card">
      <div class="stat-label">Total tokens</div>
      <div class="stat-value">${formatNumberWithCommas(totalTokens)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Pay-as-you-go for this period</div>
      <div class="stat-value">${escapeHtml(costText(report, plan))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Replies</div>
      <div class="stat-value">${formatNumberWithCommas(report.usage.messages.count)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Sent / received (tokens)</div>
      <div class="stat-value">${formatNumberWithCommas(report.usage.tokens.input)} / ${formatNumberWithCommas(report.usage.tokens.output)}</div>
    </div>
  </div>

  <h2>Models</h2>
  <table>
    <thead>
      <tr>
        <th>Model</th>
        <th class="number">Input</th>
        <th class="number">Output</th>
        <th class="number">Estimated cost</th>
      </tr>
    </thead>
    <tbody>${modelRows}
    </tbody>
  </table>

  ${dayRows ? `
  <h2>Most recent active days</h2>
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

  <p class="note">${escapeHtml(estimateNote(report))}</p>

  <div class="footer">Made by LLM Usage Analyzer on ${escapeHtml(new Date().toLocaleString())}. Unofficial: not affiliated with Anthropic, OpenAI, Google or Cursor.</div>
</body>
</html>
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
  // Some browsers start the download a moment after the click, so the address must outlive it
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The file name uses the user's own date, not UTC. */
function generateFilename(extension: string): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `usage-report-${day}.${extension}`;
}

/** Only real numbers are formatted. Anything else becomes 0, so text from a file never reaches the page. */
function formatNumberWithCommas(num: unknown): string {
  const n = Number(num);
  return Number.isFinite(n) ? formatCount(n) : '0';
}

export function escapeHtml(value: string): string {
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
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}
