import { describe, expect, test } from 'bun:test';
import { ERROR_CODES } from '../error-codes.js';
import { TICKET_LIMITS, ticketAssigneeQuery } from '../tickets.js';
import { parseHttpTicketMutationRequest, parseTicketMutationPayload, parseMarkupTicketMutationPayload } from '../ticket-commands.js';
import { parseTicketCommentsQuery, parseTicketHistoryQuery, parseTicketListQuery, parseTicketReadQuery, ticketQueryParams } from '../ticket-query.js';
import { ticketBody, ticketCommentBody, ticketId, ticketLabels, ticketProject, ticketRef, ticketTitle, ticketUuid,
  parseTicketAssigneeQuery } from '../ticket-validation.js';
import { TICKET_ERROR_POLICY } from '../../server/tickets/errors.js';
import { parseTicket, parseTicketActivity, parseTicketComment, parseTicketWriteResult } from '../ticket-records.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const STORE = '33333333-3333-4333-8333-333333333333';

describe('ticket contracts', () => {
  test('registers all wire codes centrally', () => {
    for (const code of Object.keys(TICKET_ERROR_POLICY)) expect(ERROR_CODES).toContain(code);
  });

  test('separates transport envelopes and preserves omitted markup project', () => {
    const payload = { action: 'create', input: { title: '  A ticket  ' } };
    const markup = parseMarkupTicketMutationPayload(payload);
    expect(markup.input).not.toHaveProperty('project');
    expect(markup.input.title).toBe('A ticket');
    expect(() => parseTicketMutationPayload(payload)).toThrow();
    const request = { requestId: REQUEST, expectedStoreId: STORE,
      payload: { ...payload, input: { ...payload.input, project: '  Arbitrary release  ' } } };
    expect(parseHttpTicketMutationRequest(request).payload.input.project).toBe('Arbitrary release');
    for (const changes of [{ expectedStoreId: undefined }, { requestId: 'meaningful-ref' }, { actor: 'forged' }, { ref: 'ref' }]) {
      expect(() => parseHttpTicketMutationRequest({ ...request, ...changes })).toThrow();
    }
    expect(() => parseMarkupTicketMutationPayload({ ...payload, requestId: REQUEST })).toThrow();
  });

  test('normalizes labels and rejects duplicate, invalid, or oversized input', () => {
    expect(ticketLabels(['Zulu', 'Alpha', 'alpha'])).toEqual(['Alpha', 'Zulu', 'alpha']);
    for (const labels of [['dup', ' dup '], Array.from({ length: 21 }, (_, n) => String(n)), ['x\u0085y']]) {
      expect(() => ticketLabels(labels)).toThrow();
    }
    expect(ticketTitle('😀'.repeat(240))).toHaveLength(480);
    expect(() => ticketTitle('😀'.repeat(241))).toThrow();
    expect(ticketProject('"'.repeat(4096))).toHaveLength(4096);
    expect(() => ticketProject('😀'.repeat(1025))).toThrow();
    expect(() => ticketProject('')).toThrow();
    expect(ticketRef('  fix-draft  ')).toBe('fix-draft');
    expect(() => ticketRef('x'.repeat(129))).toThrow();
    for (const text of ['x\n', 'a\u0000b', 'a\u0085b', 'a\u2028b', '\ud800']) {
      expect(() => ticketTitle(text)).toThrow();
    }
    expect(ticketBody('\u0001\n\t')).toBe('\u0001\n\t');
    expect(() => ticketBody('\ud800')).toThrow();
    expect(() => ticketBody('a'.repeat(TICKET_LIMITS.bodyBytes + 1))).toThrow();
    expect(() => ticketCommentBody(' \n\t')).toThrow();
  });

  test('validates canonical identities and nonclosed updates', () => {
    expect(ticketId('G-42')).toBe('G-42');
    for (const id of ['G-01', 'g-42', 'ISS-42', 'G-0', 'G-9007199254740992']) expect(() => ticketId(id)).toThrow();
    expect(ticketUuid(REQUEST, 'requestId')).toBe(REQUEST);
    expect(() => ticketUuid('11111111-1111-1111-1111-111111111111', 'requestId')).toThrow();
    for (const patch of [{}, { status: 'closed' }, { resolution: 'done' }, { title: undefined }]) {
      expect(() => parseTicketMutationPayload({ action: 'update', ticketId: 'G-1', expectedRevision: 1, patch })).toThrow();
    }
  });

  test('parses every mutation shape and rejects surplus fields', () => {
    const target = { ticketId: 'G-1', expectedRevision: 1 };
    const commands = [
      { action: 'create', input: { title: 'Ticket', project: 'Project' } },
      { action: 'update', ...target, patch: { status: 'in-review' } },
      ...['claim', 'release', 'reopen', 'close'].map((action) => ({ action, ...target })),
      { action: 'comment', ticketId: 'G-1', body: 'Comment' },
      { action: 'comment-edit', ...target, commentId: REQUEST, body: 'Edited' },
      { action: 'comment-delete', ...target, commentId: REQUEST },
      ...['link', 'unlink'].map((action) => ({ action, ...target, targetId: 'G-2', targetRevision: 1, kind: 'blocks' })),
    ];
    for (const command of commands) {
      expect(parseTicketMutationPayload(command).action).toBe(command.action);
      expect(() => parseTicketMutationPayload({ ...command, unexpected: true })).toThrow();
    }
  });

  test('fences mutable continuation, leaves immutable history unfenced', () => {
    expect(() => parseTicketListQuery({ beforeNumber: 10 })).toThrow();
    expect(() => parseTicketCommentsQuery({ ticketId: 'G-1', beforeSequence: 10 })).toThrow();
    expect(() => parseTicketReadQuery({ ticketId: 'G-1', beforeCommentSequence: 10 })).toThrow();
    expect(() => parseTicketReadQuery({ ticketId: 'G-1', beforeCommentSequence: 10, expectedCollectionRevision: 2, commentLimit: 0 })).toThrow();
    expect(parseTicketReadQuery({ ticketId: 'G-1', commentLimit: 0 }).commentLimit).toBe(0);
    expect(parseTicketHistoryQuery({ ticketId: 'G-1', beforeSequence: 10 })).toEqual({ ticketId: 'G-1', beforeSequence: 10, limit: 50 });
    expect(() => parseTicketHistoryQuery({ ticketId: 'G-1', expectedCollectionRevision: 2 })).toThrow();
  });

  test('encodes assignees without conflating colon or Unicode usernames', () => {
    for (const owner of ['unassigned', { kind: 'chat', chatId: '1000000000000001' }, { kind: 'user', username: 'user:λ' }]) {
      const encoded = ticketAssigneeQuery(owner);
      expect(parseTicketAssigneeQuery(encoded)).toEqual(owner);
      expect(ticketQueryParams(new URLSearchParams({ assignee: encoded })).assignee).toEqual(owner);
    }
    expect(() => ticketQueryParams(new URLSearchParams('limit=10&limit=20'))).toThrow();
    expect(() => ticketQueryParams(new URLSearchParams('ready=1'))).toThrow();
    expect(() => parseTicketListQuery(ticketQueryParams(new URLSearchParams('__proto__=bad')))).toThrow();
  });

  test('round-trips typed domain records and rejects private or contradictory fields', () => {
    const actor = { kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null };
    const ticket = { id: 'G-1', number: 1, revision: 1, title: 'Synthetic ticket', description: 'Exact\nbody',
      project: 'Project', status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: actor };
    const comment = { id: REQUEST, ticketId: 'G-1', sequence: 1, revision: 1, body: 'Comment', author: actor,
      createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, deletedAt: null };
    expect(parseTicket(ticket)).toEqual(ticket);
    expect(parseTicketComment(comment)).toEqual(comment);
    expect(parseTicketWriteResult({ success: true, storeId: STORE, collectionRevision: 2, ticket, comment }).comment).toEqual(comment);
    const activity = { sequence: 1, ticketId: 'G-1', at: ticket.createdAt, actor, source: null,
      action: 'updated', changes: [{ field: 'priority', before: 2, after: 1 }] };
    expect(parseTicketActivity(activity)).toEqual(activity);
    expect(() => parseTicketActivity({ ...activity, changes: [{ field: 'priority', before: 2, after: 'High' }] })).toThrow();
    expect(() => parseTicket({ ...ticket, resolution: 'done' })).toThrow();
    expect(() => parseTicket({ ...ticket, number: 2 })).toThrow();
    expect(() => parseTicketComment({ ...comment, body: null })).toThrow();
    expect(() => parseTicketComment({ ...comment, authorityKey: 'private' })).toThrow();
    expect(() => parseTicketWriteResult({ success: true, storeId: STORE, collectionRevision: 2, ticket,
      comment: { ...comment, ticketId: 'G-2' } })).toThrow();
  });
});
