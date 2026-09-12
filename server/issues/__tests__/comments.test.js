import { afterEach, beforeEach, expect, test } from 'bun:test';
import { issueFixture, caller, CHAT_ID } from './fixture.js';

let fixture;
beforeEach(() => { fixture = issueFixture(); });
afterEach(() => { fixture.cleanup(); });

test('comment lifecycle has its own revision, authority, tombstone, and immutable history', () => {
  const created = fixture.create();
  fixture.controls.now = '2026-01-02T00:00:00.000Z';
  const added = fixture.markup({ action: 'comment', issueId: created.issue.id, body: 'Observed comment.' }, 'comment');
  expect(added.issue).toEqual(created.issue);
  expect(added.collectionRevision).toBe(2);
  const edit = { action: 'comment-edit', issueId: created.issue.id, commentId: added.comment.id,
    expectedRevision: 1, body: 'Edited comment.' };
  expect(() => fixture.write(edit, { fromChatId: CHAT_ID })).toThrow(expect.objectContaining({ code: 'ISSUE_FORBIDDEN' }));
  expect(fixture.service.comments({ issueId: created.issue.id }, caller.authority).items[0].canEdit).toBe(false);
  const authority = { kind: 'chat', chatId: CHAT_ID };
  expect(fixture.service.comments({ issueId: created.issue.id }, authority).items[0].canEdit).toBe(true);
  const edited = fixture.markup(edit, 'edit');
  expect(edited.comment).toMatchObject({ revision: 2, sequence: 1, body: 'Edited comment.' });
  expect(edited.issue.revision).toBe(1);
  expect(edited.issue.updatedAt).toBe(created.issue.updatedAt);
  expect(fixture.markup(edit, 'edit')).toEqual(edited);
  expect(() => fixture.markup(edit, 'stale-edit')).toThrow(expect.objectContaining({ code: 'ISSUE_COMMENT_REVISION_CONFLICT' }));
  const deleted = fixture.markup({ action: 'comment-delete', issueId: created.issue.id,
    commentId: edited.comment.id, expectedRevision: 2 }, 'delete');
  expect(deleted.comment.body).toBeNull();
  expect(deleted.comment.revision).toBe(3);
  expect(fixture.service.comments({ issueId: created.issue.id }, authority).items[0].canEdit).toBe(false);
  expect(fixture.service.list({}).items[0].commentCount).toBe(0);
  expect(() => fixture.markup({ ...edit, expectedRevision: 3 }, 'restore'))
    .toThrow(expect.objectContaining({ code: 'ISSUE_INVALID_TRANSITION' }));
  const again = fixture.markup({ action: 'comment-delete', issueId: created.issue.id,
    commentId: edited.comment.id, expectedRevision: 3 }, 'delete-again');
  expect(again).toEqual(deleted);
  const history = fixture.service.history({ issueId: created.issue.id }).items;
  expect(history.map((entry) => entry.action)).toEqual(['created', 'comment-added', 'comment-edited', 'comment-removed']);
  expect(history[2]).toMatchObject({ before: 'Observed comment.', after: 'Edited comment.',
    source: { chatId: CHAT_ID, ordinal: 1 } });
  expect(history[3]).toMatchObject({ before: 'Edited comment.', after: null });
});

test('comment append retries after restart do not duplicate content or events', () => {
  const created = fixture.create();
  const request = fixture.request({ action: 'comment', issueId: created.issue.id, body: 'Exactly once.' });
  const first = fixture.service.executeHttp(request, caller);
  fixture.reopen();
  expect(fixture.service.executeHttp(request, caller)).toEqual(first);
  expect(fixture.service.comments({ issueId: created.issue.id }, caller.authority).items).toHaveLength(1);
  expect(fixture.service.history({ issueId: created.issue.id }).items).toHaveLength(2);
  expect(fixture.service.list({}).items[0].commentCount).toBe(1);
});

test('comment paging is gap-free and rejects changed mutable projections', () => {
  const created = fixture.create();
  for (let index = 0; index < 7; index++) fixture.write({ action: 'comment', issueId: created.issue.id, body: `Comment ${index}` });
  let page = fixture.service.read({ issueId: created.issue.id, commentLimit: 2 }, caller.authority);
  const sequences = [...page.comments.items.map((item) => item.sequence)];
  while (page.comments.nextBeforeSequence !== null) {
    page = fixture.service.read({ issueId: created.issue.id, commentLimit: 2,
      beforeCommentSequence: page.comments.nextBeforeSequence, expectedCollectionRevision: page.collectionRevision }, caller.authority);
    sequences.push(...page.comments.items.map((item) => item.sequence));
  }
  expect(sequences.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const first = fixture.service.comments({ issueId: created.issue.id, limit: 2 }, caller.authority);
  fixture.write({ action: 'comment', issueId: created.issue.id, body: 'Later comment' });
  expect(() => fixture.service.comments({ issueId: created.issue.id, limit: 2,
    beforeSequence: first.nextBeforeSequence, expectedCollectionRevision: first.collectionRevision }, caller.authority))
    .toThrow(expect.objectContaining({ code: 'ISSUE_COLLECTION_CHANGED' }));
});

test('history continuation remains valid while unrelated and newer activity append', () => {
  const created = fixture.create();
  for (let index = 0; index < 4; index++) fixture.write({ action: 'comment', issueId: created.issue.id, body: `Comment ${index}` });
  const first = fixture.service.history({ issueId: created.issue.id, limit: 2 });
  fixture.create();
  fixture.write({ action: 'comment', issueId: created.issue.id, body: 'New event' });
  const second = fixture.service.history({ issueId: created.issue.id, limit: 100, beforeSequence: first.nextBeforeSequence });
  const entries = [...first.items, ...second.items].sort((a, b) => a.sequence - b.sequence);
  expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
});
