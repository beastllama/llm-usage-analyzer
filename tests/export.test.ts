import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCSV, generatePDFHTML, escapeHtml, csvCell } from '../services/exportService.ts';
import { MOCK_DATA } from '../constants.ts';
import { clone, oneDay } from './helpers.ts';

test('the CSV states the answer, the plan and what the numbers are', () => {
  const csv = generateCSV(oneDay({ tokens: 400_000 }), 'Claude Pro');
  assert.match(csv, /^LLM Usage Report/);
  assert.match(csv, /\nPlan,Claude Pro\n/);
  assert.match(csv, /\nAnswer,Your Claude Pro plan costs less than pay-as-you-go\.\n/);
  assert.match(csv, /Costs include cached text/);
  assert.match(csv, /\nMODEL BREAKDOWN\n/);
  assert.match(csv, /\nDAILY BREAKDOWN\n/);
});

test('a plan the person never chose is marked as assumed in the CSV and the print page', () => {
  assert.match(generateCSV(oneDay({ tokens: 400_000 }), 'Claude Pro', true), /\nPlan,Claude Pro \(assumed\)\n/);
  assert.doesNotMatch(generateCSV(oneDay({ tokens: 400_000 }), 'Claude Pro', false), /assumed/);
  assert.match(generatePDFHTML(oneDay({ tokens: 400_000 }), 'Claude Pro', true), /Your answer \(Claude Pro \(assumed\)\)/);
});

test('demo data is labelled as a sample in both files', () => {
  assert.match(generateCSV(MOCK_DATA, 'Claude Pro'), /Sample data, not real usage\./);
  assert.match(generatePDFHTML(MOCK_DATA, 'Claude Pro'), /Sample data, not real usage\./);
});

test('a minimum is written as "at least", and unpriced models as "not priced"', () => {
  const cut = oneDay({ tokens: 400_000, replies: 100, unfinished: 40 });
  cut.usage.tokens.by_model['claude-mystery-9'] = { input: 10, output: 10 };
  const csv = generateCSV(cut, 'Claude Pro');
  assert.match(csv, /Pay-as-you-go for this period \(USD\),at least /);
  assert.match(csv, /mystery-9,10,10,0,0,not priced/);
  const html = generatePDFHTML(cut, 'Claude Pro');
  assert.match(html, /at least \$/);
  assert.match(html, /not priced/);
});

test('model names from a file cannot inject markup or controls into the print page', () => {
  const r = oneDay({ tokens: 1000 });
  r.usage.tokens.by_model['<img src=x onerror=alert(1)>'] = { input: 1, output: 1 };
  r.usage.tokens.by_model['"><script>alert(2)</script>'] = { input: 1, output: 1 };
  r.usage.tokens.by_model['bad\u001b[2J\nname'] = { input: 1, output: 1 };
  const html = generatePDFHTML(r, 'Claude Pro');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /bad\[2Jname/);
  assert.ok(!/[\u0000-\u0008\u000b\u001f]/.test(html));
});

test('model names with spreadsheet formulas are neutralised in the CSV, and line breaks never split a cell', () => {
  const r = oneDay({ tokens: 1000 });
  r.usage.tokens.by_model['=HYPERLINK("http://x","y")'] = { input: 1, output: 1 };
  r.usage.tokens.by_model['line\r\nbreak'] = { input: 1, output: 1 };
  const csv = generateCSV(r, 'Claude Pro');
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x"",""y""\)",1,1/);
  assert.match(csv, /\nlinebreak,1,1/);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
});

test('HTML escaping covers the five characters that matter', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});

test('a report with nothing to compare still produces files, with no answer block', () => {
  const r = clone(MOCK_DATA);
  r.usage.tokens.by_model = { 'Claude (estimated)': { input: 10, output: 10 } };
  const csv = generateCSV(r, 'Claude Pro');
  assert.doesNotMatch(csv, /\nAnswer,/);
  assert.match(csv, /not priced/);
  assert.doesNotMatch(generatePDFHTML(r, 'Claude Pro'), /class="answer"/);
});

test('the print page tells people how to save a PDF without mentioning phones', () => {
  const html = generatePDFHTML(MOCK_DATA, 'Claude Pro');
  assert.match(html, /Ctrl\+P, or Cmd\+P on a Mac/);
  assert.doesNotMatch(html, /phone/i);
});
