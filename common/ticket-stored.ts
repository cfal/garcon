import { ticketInvalid, ticketOwner, ticketRecord } from './ticket-validation.js';
import type { TicketOwner } from './tickets.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ticketInvalid('Invalid stored ticket object.');
  return value as Record<string, unknown>;
}

export function normalizeStoredTicketOwner(value: unknown): TicketOwner {
  const raw = record(value);
  if (raw.kind === 'user' && Object.hasOwn(raw, 'username')) {
    const old = ticketRecord(raw, ['kind', 'username']);
    return ticketOwner({ kind: 'user', ownerKey: old.username });
  }
  return ticketOwner(raw);
}

export function normalizeStoredTicket(value: unknown): Record<string, unknown> {
  const raw = record(value);
  return { ...raw, ...(raw.assignee != null && raw.assignee !== 'unassigned'
    ? { assignee: normalizeStoredTicketOwner(raw.assignee) } : {}) };
}

export function normalizeStoredTicketActivity(value: unknown): Record<string, unknown> {
  const raw = record(value);
  if (raw.action === 'created') return { ...raw, ticket: normalizeStoredTicket(raw.ticket) };
  if (Array.isArray(raw.changes)) return { ...raw, changes: raw.changes.map((value) => {
    const change = record(value);
    return change.field === 'assignee' ? { ...change,
      before: change.before === null ? null : normalizeStoredTicketOwner(change.before),
      after: change.after === null ? null : normalizeStoredTicketOwner(change.after) } : change;
  }) };
  return raw;
}

export function normalizeStoredTicketWriteResult(value: unknown): Record<string, unknown> {
  const raw = record(value);
  return { ...raw, ticket: normalizeStoredTicket(raw.ticket),
    ...(raw.relatedTicket !== undefined ? { relatedTicket: normalizeStoredTicket(raw.relatedTicket) } : {}) };
}

export function normalizeStoredTicketRequest(value: unknown): Record<string, unknown> {
  const raw = record(value);
  const payload = record(raw.payload);
  if (payload.action === 'create') return { ...raw, payload: { ...payload, input: normalizeStoredTicket(payload.input) } };
  if (payload.action === 'update') return { ...raw, payload: { ...payload, patch: normalizeStoredTicket(payload.patch) } };
  return raw;
}

export function normalizeStoredTicketOutcome(value: unknown): Record<string, unknown> {
  const raw = record(value);
  if (raw.context === undefined) return raw;
  const context = record(raw.context);
  return { ...raw, context: { ...context, ...(context.filters !== undefined
    ? { filters: normalizeStoredTicket(context.filters) } : {}) } };
}

export function normalizeStoredTicketResult(value: unknown): Record<string, unknown> {
  const raw = normalizeStoredTicketOutcome(value);
  if (raw.status !== 'ok') return raw;
  const data = record(raw.data);
  if (raw.command === 'read') return { ...raw, data: { ...data, ticket: normalizeStoredTicket(data.ticket) } };
  if ((raw.command === 'list' || raw.command === 'history') && Array.isArray(data.items)) {
    return { ...raw, data: { ...data, items: data.items.map(raw.command === 'list'
      ? normalizeStoredTicket : normalizeStoredTicketActivity) } };
  }
  return raw;
}
