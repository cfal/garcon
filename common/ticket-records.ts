import type { Ticket, TicketActivity, TicketComment, TicketField, TicketFieldChange, TicketWriteResult } from './tickets.js';
import { formatTicketId, ticketActor, ticketBody, ticketCommentBody, storedTicketId, ticketInteger, ticketInvalid, ticketLabels,
  ticketLinkKind, ticketOwner, ticketPriority, ticketProject, ticketRecord, ticketResolution, ticketSource,
  ticketStatus, ticketTimestamp, ticketTitle, ticketUuid } from './ticket-validation.js';

const ticketKeys = ['id', 'number', 'revision', 'title', 'description', 'project', 'status', 'resolution',
  'priority', 'labels', 'assignee', 'parentId', 'createdAt', 'updatedAt', 'createdBy'];
const commentKeys = ['id', 'ticketId', 'sequence', 'revision', 'body', 'author', 'createdAt', 'updatedAt', 'deletedAt'];
export const TICKET_FIELDS: readonly TicketField[] = ['title', 'description', 'project', 'status', 'resolution',
  'priority', 'labels', 'assignee', 'parentId'];

export function parseTicket(value: unknown): Ticket {
  const raw = ticketRecord(value, ticketKeys);
  const id = storedTicketId(raw.id);
  const number = ticketInteger(raw.number, 'number');
  if (id !== formatTicketId(number)) return ticketInvalid('Ticket ID and number disagree.');
  const status = ticketStatus(raw.status);
  const resolution = raw.resolution === null ? null : ticketResolution(raw.resolution);
  if ((status === 'closed') !== (resolution !== null)) return ticketInvalid('Ticket status and resolution disagree.');
  return { id, number, revision: ticketInteger(raw.revision, 'revision'),
    title: ticketTitle(raw.title), description: ticketBody(raw.description), project: ticketProject(raw.project),
    status, resolution, priority: ticketPriority(raw.priority), labels: ticketLabels(raw.labels),
    assignee: raw.assignee === null ? null : ticketOwner(raw.assignee),
    parentId: raw.parentId === null ? null : storedTicketId(raw.parentId),
    createdAt: ticketTimestamp(raw.createdAt), updatedAt: ticketTimestamp(raw.updatedAt), createdBy: ticketActor(raw.createdBy) };
}

export function parseTicketComment(value: unknown): TicketComment {
  const raw = ticketRecord(value, commentKeys);
  const deletedAt = raw.deletedAt === null ? null : ticketTimestamp(raw.deletedAt);
  const body = raw.body === null ? null : ticketCommentBody(raw.body);
  if ((deletedAt === null) !== (body !== null)) return ticketInvalid('Comment body and tombstone disagree.');
  return { id: ticketUuid(raw.id, 'commentId'), ticketId: storedTicketId(raw.ticketId),
    sequence: ticketInteger(raw.sequence, 'sequence'), revision: ticketInteger(raw.revision, 'revision'),
    body, deletedAt, author: ticketActor(raw.author),
    createdAt: ticketTimestamp(raw.createdAt), updatedAt: ticketTimestamp(raw.updatedAt) };
}

function fieldValue<K extends TicketField>(field: K, value: unknown): Ticket[K] {
  let parsed: Ticket[TicketField];
  switch (field) {
    case 'title': parsed = ticketTitle(value); break;
    case 'description': parsed = ticketBody(value); break;
    case 'project': parsed = ticketProject(value); break;
    case 'status': parsed = ticketStatus(value); break;
    case 'resolution': parsed = value === null ? null : ticketResolution(value); break;
    case 'priority': parsed = ticketPriority(value); break;
    case 'labels': parsed = ticketLabels(value); break;
    case 'assignee': parsed = value === null ? null : ticketOwner(value); break;
    case 'parentId': parsed = value === null ? null : storedTicketId(value); break;
    default: return ticketInvalid('Invalid activity field.');
  }
  return parsed as Ticket[K];
}

function parseChange(value: unknown): TicketFieldChange {
  const raw = ticketRecord(value, ['field', 'before', 'after']);
  if (!TICKET_FIELDS.includes(raw.field as TicketField)) return ticketInvalid('Invalid activity field.');
  const field = raw.field as TicketField;
  return { field, before: fieldValue(field, raw.before), after: fieldValue(field, raw.after) } as TicketFieldChange;
}

export function parseTicketActivity(value: unknown): TicketActivity {
  const baseKeys = ['sequence', 'ticketId', 'at', 'actor', 'source', 'action'];
  const raw = ticketRecord(value, [...baseKeys, 'ticket', 'changes', 'commentId', 'before', 'after', 'kind', 'sourceId', 'targetId']);
  const base = { sequence: ticketInteger(raw.sequence, 'sequence'), ticketId: storedTicketId(raw.ticketId),
    at: ticketTimestamp(raw.at), actor: ticketActor(raw.actor), source: raw.source === null ? null : ticketSource(raw.source) };
  switch (raw.action) {
    case 'created': {
      ticketRecord(raw, [...baseKeys, 'ticket']);
      const ticket = parseTicket(raw.ticket);
      if (ticket.id !== base.ticketId) return ticketInvalid('Activity ticket disagrees.');
      return { ...base, action: raw.action, ticket };
    }
    case 'updated': case 'claimed': case 'released': case 'closed': case 'reopened':
      ticketRecord(raw, [...baseKeys, 'changes']);
      if (!Array.isArray(raw.changes) || raw.changes.length > TICKET_FIELDS.length) return ticketInvalid('Invalid activity changes.');
      return { ...base, action: raw.action, changes: raw.changes.map(parseChange) };
    case 'comment-added': case 'comment-edited': case 'comment-removed':
      ticketRecord(raw, [...baseKeys, 'commentId', 'before', 'after']);
      return { ...base, action: raw.action, commentId: ticketUuid(raw.commentId, 'commentId'),
        before: raw.before === null ? null : ticketCommentBody(raw.before),
        after: raw.after === null ? null : ticketCommentBody(raw.after) };
    case 'linked': case 'unlinked':
      ticketRecord(raw, [...baseKeys, 'kind', 'sourceId', 'targetId']);
      return { ...base, action: raw.action, kind: ticketLinkKind(raw.kind),
        sourceId: storedTicketId(raw.sourceId), targetId: storedTicketId(raw.targetId) };
    default: return ticketInvalid('Invalid activity action.');
  }
}

export function parseTicketWriteResult(value: unknown): TicketWriteResult {
  const raw = ticketRecord(value, ['success', 'storeId', 'collectionRevision', 'ticket', 'comment', 'relatedTicket']);
  if (raw.success !== true) return ticketInvalid('Expected a successful ticket result.');
  const ticket = parseTicket(raw.ticket);
  const comment = raw.comment === undefined ? undefined : parseTicketComment(raw.comment);
  if (comment && comment.ticketId !== ticket.id) return ticketInvalid('Result comment belongs to another ticket.');
  return { success: true, storeId: ticketUuid(raw.storeId, 'storeId'),
    collectionRevision: ticketInteger(raw.collectionRevision, 'collectionRevision', 0), ticket,
    ...(comment ? { comment } : {}),
    ...(raw.relatedTicket !== undefined ? { relatedTicket: parseTicket(raw.relatedTicket) } : {}) };
}
