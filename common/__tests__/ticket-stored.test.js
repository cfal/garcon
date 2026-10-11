import { expect, test } from 'bun:test';
import { normalizeStoredTicketOwner, normalizeStoredTicketActivity, normalizeStoredTicketWriteResult,
  normalizeStoredTicketRequest, normalizeStoredTicketResult, normalizeStoredTicketOutcome } from '../ticket-stored.js';
import { ticketOwner, parseTicketAssigneeQuery } from '../ticket-validation.js';
import { parseTicketMutationPayload } from '../ticket-commands.js';

const legacy = { kind: 'user', username: ' owner:original ' };
const current = { kind: 'user', ownerKey: legacy.username };
test('owner keys are lossless and current commands reject historical or mixed owners', () => {
  expect(normalizeStoredTicketOwner(legacy)).toEqual(current);
  expect(parseTicketAssigneeQuery(`user:${legacy.username}`)).toEqual(current);
  expect(() => ticketOwner(legacy)).toThrow();
  expect(() => normalizeStoredTicketOwner({ ...legacy, ownerKey: 'other' })).toThrow();
  expect(() => parseTicketMutationPayload({ action: 'create', input: { title: 'Synthetic', project: 'Project', assignee: legacy } })).toThrow();
});
test('normalization touches only known ownership slots, never actor labels or author text', () => {
  const actor = { kind: 'user', username: 'historical actor', principalMode: 'authenticated', declaredChatId: null };
  const ticket = { assignee: legacy, createdBy: actor, description: 'username' };
  expect(normalizeStoredTicketActivity({ action: 'created', actor, ticket })).toEqual({ action: 'created', actor, ticket: { ...ticket, assignee: current } });
  expect(normalizeStoredTicketActivity({ action: 'updated', changes: [{ field: 'assignee', before: legacy, after: null }] }).changes)
    .toEqual([{ field: 'assignee', before: current, after: null }]);
  expect(normalizeStoredTicketWriteResult({ ticket, relatedTicket: ticket, comment: { author: actor } }))
    .toEqual({ ticket: { ...ticket, assignee: current }, relatedTicket: { ...ticket, assignee: current }, comment: { author: actor } });
  for (const [action, field] of [['create', 'input'], ['update', 'patch']]) {
    expect(normalizeStoredTicketRequest({ requestId: 'same', payload: { action, [field]: { assignee: legacy } } }))
      .toEqual({ requestId: 'same', payload: { action, [field]: { assignee: current } } });
  }
  expect(normalizeStoredTicketOutcome({ context: { filters: { assignee: legacy } } }).context.filters.assignee).toEqual(current);
  expect(normalizeStoredTicketResult({ command: 'read', status: 'ok', data: { ticket } }).data.ticket.assignee).toEqual(current);
  expect(normalizeStoredTicketResult({ command: 'list', status: 'ok', data: { items: [ticket] } }).data.items[0].assignee).toEqual(current);
  expect(normalizeStoredTicketResult({ command: 'history', status: 'ok', data: { items: [{ action: 'created', actor, ticket }] } }).data.items[0].ticket.assignee).toEqual(current);
});
