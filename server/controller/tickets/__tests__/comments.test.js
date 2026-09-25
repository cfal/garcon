import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ticketFixture, caller, CHAT_ID } from './fixture.js';

let fixture;
beforeEach(() => { fixture = ticketFixture(); });
afterEach(() => { fixture.cleanup(); });

test('comment lifecycle has its own revision, authority, tombstone, and immutable history', () => {
  const created = fixture.create();
  fixture.controls.now = '2026-01-02T00:00:00.000Z';
  const added = fixture.markup({ action: 'comment', ticketId: created.ticket.id, body: 'Observed comment.' }, 'comment');
  expect(added.ticket).toEqual(created.ticket);
  expect(added.collectionRevision).toBe(2);
  const edit = { action: 'comment-edit', ticketId: created.ticket.id, commentId: added.comment.id,
    expectedRevision: 1, body: 'Edited comment.' };
  expect(() => fixture.write(edit, { fromChatId: CHAT_ID })).toThrow(expect.objectContaining({ code: 'TICKET_FORBIDDEN' }));
  expect(fixture.service.comments({ ticketId: created.ticket.id }, caller.authority).items[0].canEdit).toBe(false);
  const authority = { kind: 'chat', chatId: CHAT_ID };
  expect(fixture.service.comments({ ticketId: created.ticket.id }, authority).items[0].canEdit).toBe(true);
  const edited = fixture.markup(edit, 'edit');
  expect(edited.comment).toMatchObject({ revision: 2, sequence: 1, body: 'Edited comment.' });
  expect(edited.ticket.revision).toBe(1);
  expect(edited.ticket.updatedAt).toBe(created.ticket.updatedAt);
  expect(fixture.markup(edit, 'edit')).toEqual(edited);
  expect(() => fixture.markup(edit, 'stale-edit')).toThrow(expect.objectContaining({ code: 'TICKET_COMMENT_REVISION_CONFLICT' }));
  const deleted = fixture.markup({ action: 'comment-delete', ticketId: created.ticket.id,
    commentId: edited.comment.id, expectedRevision: 2 }, 'delete');
  expect(deleted.comment.body).toBeNull();
  expect(deleted.comment.revision).toBe(3);
  expect(fixture.service.comments({ ticketId: created.ticket.id }, authority).items[0].canEdit).toBe(false);
  expect(fixture.service.list({}).items[0].commentCount).toBe(0);
  expect(() => fixture.markup({ ...edit, expectedRevision: 3 }, 'restore'))
    .toThrow(expect.objectContaining({ code: 'TICKET_INVALID_TRANSITION' }));
  const again = fixture.markup({ action: 'comment-delete', ticketId: created.ticket.id,
    commentId: edited.comment.id, expectedRevision: 3 }, 'delete-again');
  expect(again).toEqual(deleted);
  const history = fixture.service.history({ ticketId: created.ticket.id }).items;
  expect(history.map((entry) => entry.action)).toEqual(['created', 'comment-added', 'comment-edited', 'comment-removed']);
  expect(history[2]).toMatchObject({ before: 'Observed comment.', after: 'Edited comment.',
    source: { chatId: CHAT_ID, ordinal: 1 } });
  expect(history[3]).toMatchObject({ before: 'Edited comment.', after: null });
});

test('comment append retries after restart do not duplicate content or events', () => {
  const created = fixture.create();
  const request = fixture.request({ action: 'comment', ticketId: created.ticket.id, body: 'Exactly once.' });
  const first = fixture.service.executeHttp(request, caller);
  fixture.reopen();
  expect(fixture.service.executeHttp(request, caller)).toEqual(first);
  expect(fixture.service.comments({ ticketId: created.ticket.id }, caller.authority).items).toHaveLength(1);
  expect(fixture.service.history({ ticketId: created.ticket.id }).items).toHaveLength(2);
  expect(fixture.service.list({}).items[0].commentCount).toBe(1);
});

test('comment paging is gap-free and rejects changed mutable projections', () => {
  const created = fixture.create();
  for (let index = 0; index < 7; index++) fixture.write({ action: 'comment', ticketId: created.ticket.id, body: `Comment ${index}` });
  let page = fixture.service.read({ ticketId: created.ticket.id, commentLimit: 2 }, caller.authority);
  const sequences = [...page.comments.items.map((item) => item.sequence)];
  while (page.comments.nextBeforeSequence !== null) {
    page = fixture.service.read({ ticketId: created.ticket.id, commentLimit: 2,
      beforeCommentSequence: page.comments.nextBeforeSequence, expectedCollectionRevision: page.collectionRevision }, caller.authority);
    sequences.push(...page.comments.items.map((item) => item.sequence));
  }
  expect(sequences.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const first = fixture.service.comments({ ticketId: created.ticket.id, limit: 2 }, caller.authority);
  fixture.write({ action: 'comment', ticketId: created.ticket.id, body: 'Later comment' });
  expect(() => fixture.service.comments({ ticketId: created.ticket.id, limit: 2,
    beforeSequence: first.nextBeforeSequence, expectedCollectionRevision: first.collectionRevision }, caller.authority))
    .toThrow(expect.objectContaining({ code: 'TICKET_COLLECTION_CHANGED' }));
});

test('history continuation remains valid while unrelated and newer activity append', () => {
  const created = fixture.create();
  for (let index = 0; index < 4; index++) fixture.write({ action: 'comment', ticketId: created.ticket.id, body: `Comment ${index}` });
  const first = fixture.service.history({ ticketId: created.ticket.id, limit: 2 });
  fixture.create();
  fixture.write({ action: 'comment', ticketId: created.ticket.id, body: 'New event' });
  const second = fixture.service.history({ ticketId: created.ticket.id, limit: 100, beforeSequence: first.nextBeforeSequence });
  const entries = [...first.items, ...second.items].sort((a, b) => a.sequence - b.sequence);
  expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
});
