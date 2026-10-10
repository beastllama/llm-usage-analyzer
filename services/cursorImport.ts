// Cursor's usage export (cursor.com dashboard → Usage → Export CSV). Cursor documents no format for it, so this follows
// real exported files and the open-source tools that read them (checked 2026-10-10), and turns away anything else:
//   Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
// Older exports lack some columns, so columns are found by name.
// Despite their names, the two "Input" columns are separate amounts: cache writes, and input without them. In every
// real row checked, Total Tokens is the sum of the four token columns.
// Models are Cursor's own labels ("auto", "composer-2.5", ...). A label is priced only when it is a model id with a
// published price; "auto" names no model, so it is never priced.
// Kind says whether the plan covered a row ("Included") or Cursor billed it on demand; Cost then gives the amount.
import type { UsageReport } from '../types';
import { billingKey } from './pricing';

const REQUIRED = ['Date', 'Model', 'Input (w/ Cache Write)', 'Input (w/o Cache Write)', 'Cache Read', 'Output Tokens'];

/** The first line of a Cursor export has these columns. */
export function looksLikeCursorCsv(text: string): boolean {
  const header = splitRows(text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '')[0] ?? [];
  return REQUIRED.every((name) => header.includes(name));
}

/** RFC 4180 rows: quoted fields may hold commas, line breaks and doubled quotes. */
function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** A whole number of tokens from a cell: empty is 0; anything that is not a plain count makes the row unreadable. */
function count(cell: string | undefined): number | null {
  const text = (cell ?? '').trim();
  if (text === '') return 0;
  if (!/^\d{1,15}$/.test(text)) return null;
  return Number(text);
}

const localDay = (d: Date) =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Cursor's usage export did not exist before this, so an earlier date is a damaged row. A day ahead allows for time zones.
const EARLIEST = Date.UTC(2023, 0, 1);
const plausible = (d: Date) => !Number.isNaN(d.getTime()) && d.getTime() >= EARLIEST && d.getTime() <= Date.now() + 86_400_000;

/** A cost cell as a number of dollars, or null when it is not one ("Included", "-", empty). */
function dollars(cell: string | undefined): number | null {
  const text = (cell ?? '').trim().replace(/^\$/, '');
  return /^\d{1,9}(\.\d{1,6})?$/.test(text) ? Number(text) : null;
}

/** A model label as a table key. Kept short, and cleaned of anything that is not part of a name. */
const label = (text: string): string => text.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f-\u009f]/g, '') || 'unknown';

export type CursorImport = { ok: true; report: UsageReport; skipped: number } | { ok: false; error: string };

export function parseCursorCsv(text: string): CursorImport {
  const rows = splitRows(text.replace(/^﻿/, ''));
  const header = rows[0] ?? [];
  const col = (name: string) => header.indexOf(name);
  if (!REQUIRED.every((name) => col(name) >= 0)) {
    return { ok: false, error: "That CSV isn't a Cursor usage export. Export it again from Cursor's Usage page." };
  }

  const report: UsageReport = {
    provider: 'other',
    product: 'cursor',
    tool: 'Cursor',
    source: 'manual_upload',
    period: { start: new Date().toISOString(), end: new Date().toISOString() },
    plan: { name: 'Not set', price_usd: 0, type: 'subscription' },
    usage: {
      // A dictionary with no inherited keys: a label like "constructor" or "__proto__" is just a label
      tokens: { input: 0, output: 0, cached: 0, by_model: Object.create(null) },
      messages: { count: 0, by_day: [] },
      sessions: { count: 0 },
    },
  };
  const days = new Map<string, { count: number; input: number; output: number }>();
  let first: Date | null = null;
  let last: Date | null = null;
  let skipped = 0;
  let bad = 0;
  const onDemand = { usd: 0, rows: 0, rows_without_cost: 0 };

  for (const row of rows.slice(1)) {
    // Rows Cursor did not charge for (a failed request) are not usage anyone paid for
    if (col('Kind') >= 0 && /no charge/i.test(row[col('Kind')] ?? '')) { skipped++; continue; }
    const when = new Date((row[col('Date')] ?? '').trim());
    const kind = col('Kind') >= 0 ? (row[col('Kind')] ?? '').trim() : '';
    const write = count(row[col('Input (w/ Cache Write)')]);
    const input = count(row[col('Input (w/o Cache Write)')]);
    const read = count(row[col('Cache Read')]);
    const output = count(row[col('Output Tokens')]);
    if (!plausible(when) || write === null || input === null || read === null || output === null) { bad++; continue; }

    // Use the plan did not cover is billed on demand. The export's Cost column says how much, when it says.
    if (kind && !/^included/i.test(kind)) {
      onDemand.rows++;
      const cost = col('Cost') >= 0 ? dollars(row[col('Cost')]) : null;
      if (cost === null) onDemand.rows_without_cost++;
      else onDemand.usd += cost;
    }

    // Long prompts and dated price changes are billed under their own price, as in the command's readers
    const model = billingKey(label(row[col('Model')] ?? ''), input + read + write, when);
    const m = report.usage.tokens.by_model[model] ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    m.input += input;
    m.output += output;
    m.cache_read = (m.cache_read ?? 0) + read;
    m.cache_write = (m.cache_write ?? 0) + write;
    report.usage.tokens.by_model[model] = m;
    report.usage.tokens.input += input;
    report.usage.tokens.output += output;
    report.usage.tokens.cached = (report.usage.tokens.cached ?? 0) + read + write;
    report.usage.messages.count++;

    const key = localDay(when);
    const day = days.get(key) ?? { count: 0, input: 0, output: 0 };
    day.count++;
    day.input += input;
    day.output += output;
    days.set(key, day);
    if (!first || when < first) first = when;
    if (!last || when > last) last = when;
  }

  if (bad > 0 && report.usage.messages.count === 0) {
    return { ok: false, error: "We couldn't read the rows of that Cursor export. Export it again from Cursor's Usage page." };
  }
  if (report.usage.messages.count === 0) {
    return { ok: false, error: 'That Cursor export has no usage in it.' };
  }
  // Rows that could not be read leave the totals short
  if (bad > 0) report.usage.incomplete = true;
  if (onDemand.rows > 0) report.usage.on_demand = { ...onDemand, usd: Math.round(onDemand.usd * 1e6) / 1e6 };
  if (first && last) {
    report.period.start = first.toISOString();
    report.period.end = last.toISOString();
  }
  report.usage.messages.by_day = [...days.entries()].map(([date, d]) => ({ date, ...d })).sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, report, skipped };
}
