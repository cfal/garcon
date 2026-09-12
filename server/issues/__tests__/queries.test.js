import { afterEach, beforeEach, expect, test } from 'bun:test';
import { issueFixture, caller } from './fixture.js';
import { issueBytes } from '../../../common/issue-validation.js';
import { HTTP_ISSUE_BUDGET } from '../queries.js';

let fixture;
beforeEach(() => { fixture = issueFixture(); });
afterEach(() => { fixture.cleanup(); });

test('searches literal descriptions after NUL with ASCII-only case folding', () => {
  const first = fixture.create({ description: 'Prefix\0NeEdLe_%\\suffix Ä' }).issue;
  fixture.create({ description: 'Other needle without punctuation' });
  for (const query of ['needle_%', 'NeEdLe_%', '\\suffix', 'Ä']) {
    expect(fixture.service.list({ query }).items.map((issue) => issue.id)).toEqual([first.id]);
    expect(fixture.service.counts({ query }).counts.open).toBe(1);
  }
  expect(fixture.service.list({ query: 'ä' }).items).toEqual([]);
});

test('filters by project, owner, status, priority, and literal search/label without wildcard leakage', () => {
  const first = fixture.create({ title: 'A_100% match', project: 'Release', priority: 1, labels: ['label'],
    assignee: { kind: 'user', username: 'local' } }).issue;
  fixture.create({ title: 'A different match', project: 'Other' });
  expect(fixture.service.list({ project: 'Release', label: 'label', priority: 1,
    assignee: { kind: 'user', username: 'local' } }).items.map((item) => item.id)).toEqual([first.id]);
  expect(fixture.service.list({ query: '_100%' }).items.map((item) => item.id)).toEqual([first.id]);
  expect(fixture.service.list({ query: first.id }).items).toHaveLength(1);
  expect(fixture.service.list({ query: '\\' }).items).toHaveLength(0);
  fixture.write({ action: 'close', issueId: first.id, expectedRevision: 1 });
  expect(fixture.service.list({}).items).toHaveLength(1);
  expect(fixture.service.list({ includeClosed: true }).items).toHaveLength(2);
  expect(fixture.service.list({ status: 'closed' }).items.map((item) => item.id)).toEqual([first.id]);
  expect(fixture.service.counts({}).counts).toEqual({ open: 1, 'in-progress': 0, 'in-review': 0, closed: 0 });
  expect(fixture.service.counts({ includeClosed: true }).counts.closed).toBe(1);
  expect(fixture.service.facets('project', 'Re').values).toEqual(['Release']);
  expect(fixture.service.facets('label', '').values).toEqual(['label']);
});

test('packs a requested 100 maximum-sized summaries into complete byte-bounded pages', () => {
  const labels = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, '0')}${'😀'.repeat(62)}`);
  for (let index = 0; index < 100; index++) fixture.create({ title: '😀'.repeat(240), project: '"'.repeat(4096), labels });
  let page = fixture.service.list({ limit: 100 });
  expect(page.items.length).toBeGreaterThan(0);
  expect(page.items.length).toBeLessThan(100);
  const ids = [];
  for (;;) {
    expect(issueBytes(JSON.stringify(page))).toBeLessThanOrEqual(HTTP_ISSUE_BUDGET.maxBytes);
    ids.push(...page.items.map((item) => item.id));
    if (page.nextBeforeNumber === null) break;
    expect(page.nextBeforeNumber).toBe(page.items.at(-1).number);
    page = fixture.service.list({ limit: 100, beforeNumber: page.nextBeforeNumber,
      expectedCollectionRevision: page.collectionRevision });
  }
  expect(ids).toEqual(Array.from({ length: 100 }, (_, index) => `ISS-${100 - index}`));
  expect(() => fixture.service.list({ limit: 100 }, { ...HTTP_ISSUE_BUDGET, maxBytes: 10 }))
    .toThrow(expect.objectContaining({ code: 'ISSUE_RESULT_TOO_LARGE' }));
});

test('packs comment continuation without skipping an overflow record', () => {
  const issue = fixture.create().issue;
  for (let index = 0; index < 3; index++) fixture.write({ action: 'comment', issueId: issue.id, body: 'x'.repeat(5000) });
  const budget = { ...HTTP_ISSUE_BUDGET, maxBytes: 7000 };
  let page = fixture.service.comments({ issueId: issue.id }, caller.authority, budget);
  const sequences = [];
  for (;;) {
    expect(page.items).toHaveLength(1);
    sequences.push(page.items[0].sequence);
    if (page.nextBeforeSequence === null) break;
    page = fixture.service.comments({ issueId: issue.id, beforeSequence: page.nextBeforeSequence,
      expectedCollectionRevision: page.collectionRevision }, caller.authority, budget);
  }
  expect(sequences).toEqual([3, 2, 1]);
  expect(() => fixture.service.comments({ issueId: issue.id }, caller.authority, { ...budget, maxBytes: 1000 }))
    .toThrow(expect.objectContaining({ code: 'ISSUE_RESULT_TOO_LARGE' }));
  expect(fixture.service.read({ issueId: issue.id, includeDescription: false, commentLimit: 0 }, caller.authority, { ...budget, maxBytes: 1000 }))
    .toMatchObject({ issue: { description: null }, comments: { items: [], nextBeforeSequence: null } });
});

test('declines stale list and counts revisions before mixing pages', () => {
  fixture.create();
  fixture.create();
  const first = fixture.service.list({ limit: 1 });
  fixture.create();
  expect(() => fixture.service.list({ beforeNumber: first.nextBeforeNumber,
    expectedCollectionRevision: first.collectionRevision })).toThrow(expect.objectContaining({ code: 'ISSUE_COLLECTION_CHANGED' }));
  expect(() => fixture.service.counts({ expectedCollectionRevision: first.collectionRevision }))
    .toThrow(expect.objectContaining({ code: 'ISSUE_COLLECTION_CHANGED' }));
});
