import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { storageService } from '../services/storageService.ts';
import { clone } from './helpers.ts';
import { MOCK_DATA } from '../constants.ts';

// The app runs in a browser. These tests give it a small stand-in for browser storage.
class FakeStorage {
  data = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string) { this.data.delete(key); }
}

let store: FakeStorage;
const g = globalThis as any;

beforeEach(() => {
  store = new FakeStorage();
  g.window = { localStorage: store, sessionStorage: new FakeStorage() };
});
afterEach(() => { delete g.window; });

const report = (start: string, end: string) => {
  const r = clone(MOCK_DATA);
  r.period = { start, end };
  return r;
};

test('a saved report comes back, named by the dates it covers', () => {
  const saved = storageService.saveReport(report(new Date(2026, 8, 1).toISOString(), new Date(2026, 8, 15).toISOString()));
  assert.ok(saved);
  assert.equal(saved.name, 'Sep 1, 2026 to Sep 15, 2026');
  const all = storageService.getReports();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, saved.id);
});

test('two reports from the same month get different names', () => {
  const a = storageService.saveReport(report(new Date(2026, 8, 1).toISOString(), new Date(2026, 8, 10).toISOString()));
  const b = storageService.saveReport(report(new Date(2026, 8, 11).toISOString(), new Date(2026, 8, 20).toISOString()));
  assert.notEqual(a?.name, b?.name);
});

test('the newest report is first, and the list keeps at most 50', () => {
  for (let i = 0; i < 53; i++) {
    storageService.saveReport(report(new Date(2026, 0, 1 + i).toISOString(), new Date(2026, 0, 1 + i, 12).toISOString()));
  }
  const all = storageService.getReports();
  assert.equal(all.length, 50);
  assert.match(all[0].name ?? '', /Feb 22, 2026/);
});

test('entries that are damaged, hand-edited or from another program are left out, and the rest are kept', () => {
  const good = storageService.saveReport(report('2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'));
  assert.ok(good);
  const list = JSON.parse(store.getItem('llm_usage_history')!);
  list.push({ id: 'x', savedAt: 'now', name: 'broken', report: { provider: 'anthropic' } });
  list.push({ id: 5, savedAt: 'now', name: 'wrong id', report: clone(MOCK_DATA) });
  list.push(null, 'text', 7);
  store.setItem('llm_usage_history', JSON.stringify(list));
  const all = storageService.getReports();
  assert.deepEqual(all.map((r) => r.id), [good.id]);
});

test('a list that is not a list is treated as empty', () => {
  store.setItem('llm_usage_history', JSON.stringify({ not: 'a list' }));
  assert.deepEqual(storageService.getReports(), []);
});

test('unreadable text is set aside and not overwritten by the next save', () => {
  store.setItem('llm_usage_history', '{broken');
  assert.deepEqual(storageService.getReports(), []);
  assert.equal(store.getItem('llm_usage_history'), null);
  assert.equal(store.getItem('llm_usage_history_unreadable'), '{broken');
  assert.ok(storageService.saveReport(clone(MOCK_DATA)));
  assert.equal(store.getItem('llm_usage_history_unreadable'), '{broken');
});

test('full storage is reported, not thrown, and nothing is lost', () => {
  const first = storageService.saveReport(clone(MOCK_DATA));
  assert.ok(first);
  store.failWrites = true;
  assert.equal(storageService.saveReport(report('2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')), null);
  assert.equal(storageService.deleteReport(first.id), false);
  assert.equal(storageService.updateReportData(first.id, clone(MOCK_DATA)), false);
  store.failWrites = false;
  assert.deepEqual(storageService.getReports().map((r) => r.id), [first.id]);
});

test('with no browser storage at all, everything still answers', () => {
  delete g.window;
  assert.deepEqual(storageService.getReports(), []);
  assert.equal(storageService.saveReport(clone(MOCK_DATA)), null);
  assert.equal(storageService.setReports([]), false);
  assert.doesNotThrow(() => storageService.clearHistory());
});

test('the same period is found as a duplicate, and updating it keeps its id and name and moves it first', () => {
  const a = storageService.saveReport(report('2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z'), 'My name');
  const b = storageService.saveReport(report('2026-10-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z'));
  assert.ok(a && b);
  const found = storageService.findDuplicateReport(report('2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z'));
  assert.equal(found?.id, a.id);
  assert.equal(storageService.findDuplicateReport(report('2026-09-01T00:00:00.000Z', '2026-09-16T00:00:00.000Z')), undefined);

  const newer = report('2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
  newer.usage.messages.count = 999;
  assert.equal(storageService.updateReportData(a.id, newer), true);
  const all = storageService.getReports();
  assert.deepEqual(all.map((r) => r.id), [a.id, b.id]);
  assert.equal(all[0].name, 'My name');
  assert.equal(all[0].report.usage.messages.count, 999);
  assert.equal(storageService.updateReportData('missing', newer), false);
});

test('deleting one report leaves the others, and clearing removes all', () => {
  const a = storageService.saveReport(report('2026-09-01T00:00:00.000Z', '2026-09-15T00:00:00.000Z'));
  const b = storageService.saveReport(report('2026-10-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z'));
  assert.ok(a && b);
  assert.equal(storageService.deleteReport(a.id), true);
  assert.deepEqual(storageService.getReports().map((r) => r.id), [b.id]);
  storageService.clearHistory();
  assert.deepEqual(storageService.getReports(), []);
});
