import { afterEach, beforeEach, expect, test } from 'bun:test';
import { issueFixture, caller } from './fixture.js';

let fixture;
beforeEach(() => { fixture = issueFixture(); });
afterEach(() => { fixture.cleanup(); });
const current = (id) => fixture.service.read({ issueId: id, commentLimit: 0 }, caller.authority).issue;
const link = (source, target, kind = 'blocks', action = 'link') => fixture.write({ action,
  issueId: source.id, expectedRevision: source.revision, targetId: target.id, targetRevision: target.revision, kind });

test('blocking links update both endpoints once and reject cycles atomically', () => {
  const a = fixture.create().issue;
  const b = fixture.create().issue;
  const linked = link(a, b);
  expect(linked.issue.revision).toBe(2);
  expect(linked.relatedIssue.revision).toBe(2);
  expect(linked.collectionRevision).toBe(3);
  expect(link(linked.issue, linked.relatedIssue)).toEqual(linked);
  expect(() => link(linked.relatedIssue, linked.issue)).toThrow(expect.objectContaining({ code: 'ISSUE_RELATIONSHIP_CYCLE' }));
  expect(() => link(linked.issue, linked.relatedIssue, 'related')).not.toThrow();
  expect(fixture.service.history({ issueId: a.id }).items.map((item) => item.action)).toEqual(['created', 'linked', 'linked']);
  expect(() => link(current(a.id), b, 'blocks', 'unlink')).toThrow(expect.objectContaining({ code: 'ISSUE_REVISION_CONFLICT' }));
  const removed = link(current(a.id), current(b.id), 'blocks', 'unlink');
  expect(link(removed.issue, removed.relatedIssue, 'blocks', 'unlink')).toEqual(removed);
});

test('related links are undirected and may form cycles, never self-links', () => {
  const a = fixture.create().issue;
  const b = fixture.create().issue;
  const c = fixture.create().issue;
  link(a, b, 'related');
  link(current(b.id), c, 'related');
  link(current(c.id), current(a.id), 'related');
  const before = fixture.invalidations.length;
  link(current(b.id), current(a.id), 'related');
  expect(fixture.invalidations).toHaveLength(before);
  expect(fixture.service.read({ issueId: a.id }, caller.authority).links).toHaveLength(2);
  expect(() => link(current(a.id), current(a.id), 'related')).toThrow(expect.objectContaining({ code: 'ISSUE_RELATIONSHIP_CYCLE' }));
});

test('canceled blockers stay unresolved until done or unlinked; readiness remains discovery only', () => {
  const blocker = fixture.create().issue;
  const task = fixture.create().issue;
  link(blocker, task);
  expect(fixture.service.list({ ready: true }).items.map((item) => item.id)).toEqual([blocker.id]);
  expect(fixture.service.list({}).items.find((item) => item.id === task.id).blockedByCount).toBe(1);
  const canceled = fixture.write({ action: 'close', issueId: blocker.id, expectedRevision: 2, resolution: 'canceled' });
  expect(fixture.service.list({ ready: true }).items).toEqual([]);
  const reopened = fixture.write({ action: 'reopen', issueId: blocker.id, expectedRevision: canceled.issue.revision });
  expect(fixture.service.list({ ready: true }).items.map((item) => item.id)).toEqual([blocker.id]);
  const claimed = fixture.write({ action: 'claim', issueId: task.id, expectedRevision: 2 });
  expect(claimed.issue.status).toBe('in-progress');
  fixture.write({ action: 'close', issueId: blocker.id, expectedRevision: reopened.issue.revision });
  expect(fixture.service.list({}).items.find((item) => item.id === task.id).blockedByCount).toBe(0);
});

test('parent cycles roll back fields and parent links never imply blocking', () => {
  const parent = fixture.create().issue;
  const child = fixture.create({ parentId: parent.id, project: 'Another project' }).issue;
  expect(fixture.service.list({ ready: true }).items).toHaveLength(2);
  expect(() => fixture.write({ action: 'update', issueId: parent.id, expectedRevision: 1,
    patch: { parentId: child.id, title: 'Rolled back' } })).toThrow(expect.objectContaining({ code: 'ISSUE_RELATIONSHIP_CYCLE' }));
  expect(current(parent.id)).toEqual(parent);
  expect(() => fixture.create({ parentId: 'ISS-999' })).toThrow(expect.objectContaining({ code: 'ISSUE_NOT_FOUND' }));
  fixture.write({ action: 'close', issueId: parent.id, expectedRevision: 1 });
  expect(current(child.id).status).toBe('open');
});

test('ancestry bounds include existing descendants when moving a subtree', () => {
  let parent = fixture.create().issue;
  for (let depth = 0; depth < 99; depth++) parent = fixture.create({ parentId: parent.id }).issue;
  const root = fixture.create().issue;
  const child = fixture.create({ parentId: root.id }).issue;
  expect(() => fixture.write({ action: 'update', issueId: root.id, expectedRevision: 1, patch: { parentId: parent.id } }))
    .toThrow(expect.objectContaining({ code: 'ISSUE_LIMIT_REACHED' }));
  expect(current(root.id).parentId).toBeNull();
  expect(current(child.id).parentId).toBe(root.id);
});

test('combined link cap includes related and incoming blocking edges', () => {
  const hub = fixture.create().issue;
  for (let index = 0; index < 100; index++) {
    const other = fixture.create().issue;
    link(other, current(hub.id), index % 2 === 0 ? 'blocks' : 'related');
  }
  const extra = fixture.create().issue;
  expect(() => link(current(hub.id), extra, 'related')).toThrow(expect.objectContaining({ code: 'ISSUE_LIMIT_REACHED' }));
  expect(fixture.service.read({ issueId: hub.id }, caller.authority).links).toHaveLength(100);
  expect(current(extra.id).revision).toBe(1);
});
