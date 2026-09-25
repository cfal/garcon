import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ticketFixture, caller } from './fixture.js';

let fixture;
beforeEach(() => { fixture = ticketFixture(); });
afterEach(() => { fixture.cleanup(); });
const current = (id) => fixture.service.read({ ticketId: id, commentLimit: 0 }, caller.authority).ticket;
const link = (source, target, kind = 'blocks', action = 'link') => fixture.write({ action,
  ticketId: source.id, expectedRevision: source.revision, targetId: target.id, targetRevision: target.revision, kind });

test('blocking links update both endpoints once and reject cycles atomically', () => {
  const a = fixture.create().ticket;
  const b = fixture.create().ticket;
  const linked = link(a, b);
  expect(linked.ticket.revision).toBe(2);
  expect(linked.relatedTicket.revision).toBe(2);
  expect(linked.collectionRevision).toBe(3);
  expect(link(linked.ticket, linked.relatedTicket)).toEqual(linked);
  expect(() => link(linked.relatedTicket, linked.ticket)).toThrow(expect.objectContaining({ code: 'TICKET_RELATIONSHIP_CYCLE' }));
  expect(() => link(linked.ticket, linked.relatedTicket, 'related')).not.toThrow();
  expect(fixture.service.history({ ticketId: a.id }).items.map((item) => item.action)).toEqual(['created', 'linked', 'linked']);
  expect(() => link(current(a.id), b, 'blocks', 'unlink')).toThrow(expect.objectContaining({ code: 'TICKET_REVISION_CONFLICT' }));
  const removed = link(current(a.id), current(b.id), 'blocks', 'unlink');
  expect(link(removed.ticket, removed.relatedTicket, 'blocks', 'unlink')).toEqual(removed);
});

test('related links are undirected and may form cycles, never self-links', () => {
  const a = fixture.create().ticket;
  const b = fixture.create().ticket;
  const c = fixture.create().ticket;
  link(a, b, 'related');
  link(current(b.id), c, 'related');
  link(current(c.id), current(a.id), 'related');
  const before = fixture.invalidations.length;
  link(current(b.id), current(a.id), 'related');
  expect(fixture.invalidations).toHaveLength(before);
  expect(fixture.service.read({ ticketId: a.id }, caller.authority).links).toHaveLength(2);
  expect(() => link(current(a.id), current(a.id), 'related')).toThrow(expect.objectContaining({ code: 'TICKET_RELATIONSHIP_CYCLE' }));
});

test('canceled blockers stay unresolved until done or unlinked; readiness remains discovery only', () => {
  const blocker = fixture.create().ticket;
  const task = fixture.create().ticket;
  link(blocker, task);
  expect(fixture.service.list({ ready: true }).items.map((item) => item.id)).toEqual([blocker.id]);
  expect(fixture.service.list({}).items.find((item) => item.id === task.id).blockedByCount).toBe(1);
  const canceled = fixture.write({ action: 'close', ticketId: blocker.id, expectedRevision: 2, resolution: 'canceled' });
  expect(fixture.service.list({ ready: true }).items).toEqual([]);
  const reopened = fixture.write({ action: 'reopen', ticketId: blocker.id, expectedRevision: canceled.ticket.revision });
  expect(fixture.service.list({ ready: true }).items.map((item) => item.id)).toEqual([blocker.id]);
  const claimed = fixture.write({ action: 'claim', ticketId: task.id, expectedRevision: 2 });
  expect(claimed.ticket.status).toBe('in-progress');
  fixture.write({ action: 'close', ticketId: blocker.id, expectedRevision: reopened.ticket.revision });
  expect(fixture.service.list({}).items.find((item) => item.id === task.id).blockedByCount).toBe(0);
});

test('parent cycles roll back fields and parent links never imply blocking', () => {
  const parent = fixture.create().ticket;
  const child = fixture.create({ parentId: parent.id, project: 'Another project' }).ticket;
  expect(fixture.service.list({ ready: true }).items).toHaveLength(2);
  expect(() => fixture.write({ action: 'update', ticketId: parent.id, expectedRevision: 1,
    patch: { parentId: child.id, title: 'Rolled back' } })).toThrow(expect.objectContaining({ code: 'TICKET_RELATIONSHIP_CYCLE' }));
  expect(current(parent.id)).toEqual(parent);
  expect(() => fixture.create({ parentId: 'G-999' })).toThrow(expect.objectContaining({ code: 'TICKET_NOT_FOUND' }));
  fixture.write({ action: 'close', ticketId: parent.id, expectedRevision: 1 });
  expect(current(child.id).status).toBe('open');
});

test('ancestry bounds include existing descendants when moving a subtree', () => {
  let parent = fixture.create().ticket;
  for (let depth = 0; depth < 99; depth++) parent = fixture.create({ parentId: parent.id }).ticket;
  const root = fixture.create().ticket;
  const child = fixture.create({ parentId: root.id }).ticket;
  expect(() => fixture.write({ action: 'update', ticketId: root.id, expectedRevision: 1, patch: { parentId: parent.id } }))
    .toThrow(expect.objectContaining({ code: 'TICKET_LIMIT_REACHED' }));
  expect(current(root.id).parentId).toBeNull();
  expect(current(child.id).parentId).toBe(root.id);
});

test('combined link cap includes related and incoming blocking edges', () => {
  const hub = fixture.create().ticket;
  for (let index = 0; index < 100; index++) {
    const other = fixture.create().ticket;
    link(other, current(hub.id), index % 2 === 0 ? 'blocks' : 'related');
  }
  const extra = fixture.create().ticket;
  expect(() => link(current(hub.id), extra, 'related')).toThrow(expect.objectContaining({ code: 'TICKET_LIMIT_REACHED' }));
  expect(fixture.service.read({ ticketId: hub.id }, caller.authority).links).toHaveLength(100);
  expect(current(extra.id).revision).toBe(1);
});
