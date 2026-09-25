import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ticketFixture, caller, CHAT_ID } from './fixture.js';
import { deriveTicketCaller, ticketAuthorityKey } from '../contracts.js';
import { ticketActor, ticketOwner, parseTicketAssigneeQuery } from '../../../../common/ticket-validation.js';

const executorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const principal = { mode: 'executor', key: executorId, executorId, expiresAtMs: null };
const executorCaller = deriveTicketCaller(principal);
let fixture;
beforeEach(() => { fixture = ticketFixture(); });
afterEach(() => fixture.cleanup());

test('executor authority, attribution and default ownership remain distinct from a declared chat', () => {
  expect(executorCaller).toEqual({ actor: { kind: 'executor', executorId, declaredChatId: null },
    authority: { kind: 'principal', mode: 'executor', key: executorId }, owner: { kind: 'executor', executorId } });
  expect(deriveTicketCaller(principal, CHAT_ID)).toMatchObject({ actor: { kind: 'executor', executorId, declaredChatId: CHAT_ID },
    owner: { kind: 'chat', chatId: CHAT_ID }, authority: executorCaller.authority });
  expect(ticketAuthorityKey(executorCaller.authority)).not.toBe(ticketAuthorityKey(caller.authority));
  expect(parseTicketAssigneeQuery(`executor:${executorId}`)).toEqual({ kind: 'executor', executorId });
  for (const invalid of ['local', 'worker label', CHAT_ID]) {
    expect(() => ticketOwner({ kind: 'executor', executorId: invalid })).toThrow();
    expect(() => ticketActor({ kind: 'executor', executorId: invalid, declaredChatId: null })).toThrow();
  }
  expect(() => ticketActor({ kind: 'executor', executorId, declaredChatId: null, provenance: 'observed' })).toThrow();
});

test('executor retries and comment edit authority survive restart without deduplicating another origin', () => {
  const request = fixture.request({ action: 'create', input: { title: 'Synthetic executor ticket', project: 'Project' } });
  const first = fixture.service.executeHttp(request, executorCaller);
  const comment = fixture.service.executeHttp(fixture.request({ action: 'comment', ticketId: first.ticket.id, body: 'Synthetic comment' }), executorCaller);
  fixture.reopen();
  expect(fixture.service.executeHttp(request, deriveTicketCaller({ ...principal }))).toEqual(first);
  expect(fixture.service.read({ ticketId: first.ticket.id }, executorCaller.authority).comments.items[0].canEdit).toBe(true);
  expect(fixture.service.read({ ticketId: first.ticket.id }, caller.authority).comments.items[0].canEdit).toBe(false);
  expect(() => fixture.service.executeHttp(fixture.request({ action: 'comment-edit', ticketId: first.ticket.id,
    commentId: comment.comment.id, expectedCommentRevision: 1, body: 'Changed' }), caller)).toThrow();
  expect(fixture.service.executeHttp(request, caller).ticket.id).not.toBe(first.ticket.id);
});

test('executor claim, filter and release use the executor identity and reject foreign assignments', () => {
  const created = fixture.create();
  const claimed = fixture.service.executeHttp(fixture.request({ action: 'claim', ticketId: created.ticket.id, expectedRevision: 1 }), executorCaller);
  expect(claimed.ticket.assignee).toEqual({ kind: 'executor', executorId });
  expect(fixture.service.list({ assignee: { kind: 'executor', executorId } }).items.map((ticket) => ticket.id)).toEqual([created.ticket.id]);
  expect(() => fixture.service.executeHttp(fixture.request({ action: 'update', ticketId: created.ticket.id,
    expectedRevision: 2, patch: { assignee: { kind: 'user', username: 'local' } } }), executorCaller)).toThrow();
  expect(() => fixture.service.executeHttp(fixture.request({ action: 'update', ticketId: created.ticket.id,
    expectedRevision: 2, patch: { assignee: { kind: 'executor', executorId: crypto.randomUUID() } } }), executorCaller)).toThrow();
  const released = fixture.service.executeHttp(fixture.request({ action: 'release', ticketId: created.ticket.id, expectedRevision: 2 }), executorCaller);
  expect(released.ticket.assignee).toBeNull();
});
