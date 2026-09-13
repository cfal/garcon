import { describe, expect, test } from 'bun:test';
import { parseTicketBootstrap, parseTicketCommentsPage, parseTicketCounts, parseTicketDetail,
  parseTicketFacets, parseTicketHistoryPage, parseTicketPage, parseTicketProjectDefault } from '../ticket-responses.js';
import { TicketsInvalidatedMessage, parseServerWsMessage } from '../ws-events.js';

const version = { storeId: '11111111-1111-4111-8111-111111111111', collectionRevision: 3 };
const actor = { kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null };
const ticket = { id: 'G-1', number: 1, revision: 1, title: 'Synthetic', description: '', project: 'Synthetic project',
  status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: actor };
const comment = { id: '22222222-2222-4222-8222-222222222222', ticketId: ticket.id, sequence: 1, revision: 1,
  body: 'Synthetic comment', author: actor, createdAt: ticket.createdAt, updatedAt: ticket.createdAt, deletedAt: null, canEdit: true };
const comments = { ...version, items: [comment], nextBeforeSequence: null };

describe('ticket response contracts', () => {
  test('round-trips every projection without private fields', () => {
    const { description: _description, ...fields } = ticket;
    const page = { ...version, items: [{ ...fields, blockedByCount: 0, commentCount: 1 }], nextBeforeNumber: null };
    expect(parseTicketPage(page)).toEqual(page);
    expect(parseTicketCommentsPage(comments)).toEqual(comments);
    const detail = { ...version, ticket: { ...ticket, description: null }, links: [], comments };
    expect(parseTicketDetail(detail)).toEqual(detail);
    const history = { ...version, items: [{ sequence: 1, ticketId: ticket.id, at: ticket.createdAt,
      actor, source: null, action: 'created', ticket }], nextBeforeSequence: null };
    expect(parseTicketHistoryPage(history)).toEqual(history);
    const bootstrap = { ...version, viewerKey: '["principal","local","local"]' };
    expect(parseTicketBootstrap(bootstrap)).toEqual(bootstrap);
    const counts = { ...version, counts: { open: 1, 'in-progress': 0, 'in-review': 0, closed: 0 } };
    expect(parseTicketCounts(counts)).toEqual(counts);
    expect(parseTicketFacets({ ...version, values: ['Project'] }).values).toEqual(['Project']);
    expect(parseTicketProjectDefault({ project: '/repo', kind: 'repository' })).toEqual({ project: '/repo', kind: 'repository' });
    expect(() => parseTicketBootstrap({ ...bootstrap, token: 'private' })).toThrow();
    expect(() => parseTicketCommentsPage({ ...comments, items: [{ ...comment, authorityKey: 'private' }] })).toThrow();
  });

  test('rejects inconsistent detail identities, versions, ordering and continuations', () => {
    const detail = { ...version, ticket, links: [], comments };
    for (const patch of [{ storeId: '33333333-3333-4333-8333-333333333333' }, { collectionRevision: 4 },
      { items: [{ ...comment, ticketId: 'G-2' }] }]) {
      expect(() => parseTicketDetail({ ...detail, comments: { ...comments, ...patch } })).toThrow();
    }
    expect(() => parseTicketCommentsPage({ ...comments, nextBeforeSequence: 2 })).toThrow();
    expect(() => parseTicketCommentsPage({ ...comments, items: [comment, comment] })).toThrow();
    expect(() => parseTicketCommentsPage({ ...comments, items: [{ ...comment, body: null, deletedAt: ticket.createdAt }] })).toThrow();
    expect(() => parseTicketDetail({ ...detail, links: [{ sourceId: 'G-2', targetId: 'G-3', kind: 'blocks' }] })).toThrow();
    expect(() => parseTicketPage({ ...version, items: [], nextBeforeNumber: 1 })).toThrow();
  });

  test('accepts only a bounded revision-only WebSocket invalidation', () => {
    expect(parseServerWsMessage(JSON.parse(JSON.stringify(new TicketsInvalidatedMessage(3)))))
      .toEqual(new TicketsInvalidatedMessage(3));
    for (const revision of [-1, 0.5, '3', Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseServerWsMessage({ type: 'tickets-invalidated', revision })).toBeNull();
    }
    expect(parseServerWsMessage({ type: 'tickets-invalidated', revision: 3, body: 'private' })).toBeNull();
    expect(parseServerWsMessage({ type: 'tickets-invalidated' })).toBeNull();
  });
});
