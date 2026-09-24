import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ticketFixture, caller, CHAT_ID } from './fixture.js';
import { deriveTicketCaller, ticketAuthorityKey } from '../contracts.js';
import { ticketActor, ticketOwner, parseTicketAssigneeQuery } from '../../../common/ticket-validation.js';

const nodeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const principal = { mode: 'execution-node', key: nodeId, nodeId, expiresAtMs: null };
const nodeCaller = deriveTicketCaller(principal);
let fixture;
beforeEach(() => { fixture = ticketFixture(); });
afterEach(() => fixture.cleanup());

test('node authority, attribution and default ownership remain distinct from a declared chat', () => {
  expect(nodeCaller).toEqual({ actor: { kind: 'node', nodeId, declaredChatId: null },
    authority: { kind: 'principal', mode: 'execution-node', key: nodeId }, owner: { kind: 'node', nodeId } });
  expect(deriveTicketCaller(principal, CHAT_ID)).toMatchObject({ actor: { kind: 'node', nodeId, declaredChatId: CHAT_ID },
    owner: { kind: 'chat', chatId: CHAT_ID }, authority: nodeCaller.authority });
  expect(ticketAuthorityKey(nodeCaller.authority)).not.toBe(ticketAuthorityKey(caller.authority));
  expect(parseTicketAssigneeQuery(`node:${nodeId}`)).toEqual({ kind: 'node', nodeId });
  for (const invalid of ['local', 'worker label', CHAT_ID]) {
    expect(() => ticketOwner({ kind: 'node', nodeId: invalid })).toThrow();
    expect(() => ticketActor({ kind: 'node', nodeId: invalid, declaredChatId: null })).toThrow();
  }
  expect(() => ticketActor({ kind: 'node', nodeId, declaredChatId: null, provenance: 'observed' })).toThrow();
});

test('node retries and comment edit authority survive restart without deduplicating another origin', () => {
  const request = fixture.request({ action: 'create', input: { title: 'Synthetic node ticket', project: 'Project' } });
  const first = fixture.service.executeHttp(request, nodeCaller);
  const comment = fixture.service.executeHttp(fixture.request({ action: 'comment', ticketId: first.ticket.id, body: 'Synthetic comment' }), nodeCaller);
  fixture.reopen();
  expect(fixture.service.executeHttp(request, deriveTicketCaller({ ...principal }))).toEqual(first);
  expect(fixture.service.read({ ticketId: first.ticket.id }, nodeCaller.authority).comments.items[0].canEdit).toBe(true);
  expect(fixture.service.read({ ticketId: first.ticket.id }, caller.authority).comments.items[0].canEdit).toBe(false);
  expect(() => fixture.service.executeHttp(fixture.request({ action: 'comment-edit', ticketId: first.ticket.id,
    commentId: comment.comment.id, expectedCommentRevision: 1, body: 'Changed' }), caller)).toThrow();
  expect(fixture.service.executeHttp(request, caller).ticket.id).not.toBe(first.ticket.id);
});

test('node claim, filter and release use the node identity and reject foreign assignments', () => {
  const created = fixture.create();
  const claimed = fixture.service.executeHttp(fixture.request({ action: 'claim', ticketId: created.ticket.id, expectedRevision: 1 }), nodeCaller);
  expect(claimed.ticket.assignee).toEqual({ kind: 'node', nodeId });
  expect(fixture.service.list({ assignee: { kind: 'node', nodeId } }).items.map((ticket) => ticket.id)).toEqual([created.ticket.id]);
  expect(() => fixture.service.executeHttp(fixture.request({ action: 'update', ticketId: created.ticket.id,
    expectedRevision: 2, patch: { assignee: { kind: 'user', username: 'local' } } }), nodeCaller)).toThrow();
  expect(() => fixture.service.executeHttp(fixture.request({ action: 'update', ticketId: created.ticket.id,
    expectedRevision: 2, patch: { assignee: { kind: 'node', nodeId: crypto.randomUUID() } } }), nodeCaller)).toThrow();
  const released = fixture.service.executeHttp(fixture.request({ action: 'release', ticketId: created.ticket.id, expectedRevision: 2 }), nodeCaller);
  expect(released.ticket.assignee).toBeNull();
});
