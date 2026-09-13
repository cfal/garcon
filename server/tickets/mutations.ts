import type { Database } from 'bun:sqlite';
import type { TicketMutationPayload } from '../../common/ticket-commands.js';
import { TICKET_FIELDS } from '../../common/ticket-records.js';
import { formatTicketId } from '../../common/ticket-validation.js';
import { ticketOwnerKey, type Ticket, type TicketComment, type TicketFieldChange } from '../../common/tickets.js';
import { ticketAuthorityKey, type TicketMutationContext } from './contracts.js';
import { TicketDomainError, nextTicketCounter } from './errors.js';
import { appendActivity, decodeComment, insertComment, nextAutoincrement, requireComment,
  requireTicket, requireTicketRevision, saveTicket, updateComment } from './records.js';
import { requireLinkCapacity, requireNoBlockingCycle, validateTicketParent } from './relationships.js';

export interface TicketMutationCommit {
  readonly ticket: Ticket;
  readonly comment?: TicketComment;
  readonly relatedTicket?: Ticket;
  readonly changed: boolean;
}

function fieldChanges(current: Ticket, next: Ticket): TicketFieldChange[] {
  const changes: TicketFieldChange[] = [];
  for (const field of TICKET_FIELDS) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
      changes.push({ field, before: current[field], after: next[field] } as TicketFieldChange);
    }
  }
  return changes;
}

function commitFields(database: Database, current: Ticket, candidate: Ticket,
  action: 'updated' | 'claimed' | 'released' | 'closed' | 'reopened',
  context: TicketMutationContext, now: string): TicketMutationCommit {
  const changes = fieldChanges(current, candidate);
  if (!changes.length) return { ticket: current, changed: false };
  const ticket = { ...candidate, revision: nextTicketCounter(current.revision), updatedAt: now };
  if (ticket.parentId !== current.parentId && ticket.parentId) requireTicket(database, ticket.parentId);
  saveTicket(database, ticket);
  if (ticket.parentId !== current.parentId) validateTicketParent(database, ticket);
  appendActivity(database, ticket.id, { action, changes }, context, now);
  return { ticket, changed: true };
}

function create(database: Database, payload: Extract<TicketMutationPayload, { action: 'create' }>,
  context: TicketMutationContext, now: string): TicketMutationCommit {
  const input = payload.input;
  if (input.parentId) requireTicket(database, input.parentId);
  const number = nextAutoincrement(database, 'tickets');
  const ticket: Ticket = { id: formatTicketId(number), number, revision: 1, title: input.title,
    description: input.description ?? '', project: input.project, status: 'open', resolution: null,
    priority: input.priority ?? 2, labels: input.labels ?? [], assignee: input.assignee ?? null,
    parentId: input.parentId ?? null, createdAt: now, updatedAt: now, createdBy: context.actor };
  database.query(`INSERT INTO tickets
    (number, revision, project, status, resolution, priority, payload_json) VALUES (?,1,?,'open',NULL,?,?)`)
    .run(number, ticket.project, ticket.priority, JSON.stringify(ticket));
  saveTicket(database, ticket);
  validateTicketParent(database, ticket);
  appendActivity(database, ticket.id, { action: 'created', ticket }, context, now);
  return { ticket, changed: true };
}

function addComment(database: Database, ticket: Ticket, body: string,
  context: TicketMutationContext, now: string): TicketComment {
  const latest = database.query<{ sequence: number | null }, [number]>(
    'SELECT max(sequence) AS sequence FROM ticket_comments WHERE ticket_number=?',
  ).get(ticket.number)?.sequence ?? 0;
  const comment: TicketComment = { id: crypto.randomUUID(), ticketId: ticket.id,
    sequence: nextTicketCounter(latest), revision: 1, body, author: context.actor,
    createdAt: now, updatedAt: now, deletedAt: null };
  insertComment(database, comment, ticketAuthorityKey(context.authority));
  appendActivity(database, ticket.id, { action: 'comment-added', commentId: comment.id, before: null, after: body }, context, now);
  return comment;
}

function changeComment(database: Database, ticket: Ticket,
  payload: Extract<TicketMutationPayload, { action: 'comment-edit' | 'comment-delete' }>,
  context: TicketMutationContext, now: string): TicketMutationCommit {
  const stored = requireComment(database, payload.commentId, ticket.id);
  if (stored.authority_key !== ticketAuthorityKey(context.authority)) {
    throw new TicketDomainError('TICKET_FORBIDDEN', 'Only the comment author can change it.');
  }
  const current = decodeComment(stored);
  if (current.revision !== payload.expectedRevision) {
    throw new TicketDomainError('TICKET_COMMENT_REVISION_CONFLICT', 'Comment changed. Read it before retrying.', undefined, current);
  }
  if (payload.action === 'comment-edit' && current.deletedAt !== null) {
    throw new TicketDomainError('TICKET_INVALID_TRANSITION', 'Removed comments cannot be edited.');
  }
  if ((payload.action === 'comment-delete' && current.deletedAt !== null)
    || (payload.action === 'comment-edit' && current.body === payload.body)) {
    return { ticket, comment: current, changed: false };
  }
  const deleting = payload.action === 'comment-delete';
  const body = payload.action === 'comment-edit' ? payload.body : null;
  const comment = { ...current, body, revision: nextTicketCounter(current.revision), updatedAt: now,
    deletedAt: deleting ? now : null };
  updateComment(database, comment);
  appendActivity(database, ticket.id, { action: deleting ? 'comment-removed' : 'comment-edited',
    commentId: comment.id, before: current.body, after: body }, context, now);
  return { ticket, comment, changed: true };
}

function changeLink(database: Database, ticket: Ticket,
  payload: Extract<TicketMutationPayload, { action: 'link' | 'unlink' }>,
  context: TicketMutationContext, now: string): TicketMutationCommit {
  const target = requireTicket(database, payload.targetId);
  requireTicketRevision(target, payload.targetRevision);
  if (ticket.id === target.id) throw new TicketDomainError('TICKET_RELATIONSHIP_CYCLE', 'A ticket cannot link to itself.');
  let sourceNumber = ticket.number;
  let targetNumber = target.number;
  if (payload.kind === 'related' && sourceNumber > targetNumber) [sourceNumber, targetNumber] = [targetNumber, sourceNumber];
  const existing = database.query('SELECT 1 FROM ticket_links WHERE source_number=? AND target_number=? AND kind=?')
    .get(sourceNumber, targetNumber, payload.kind);
  if ((payload.action === 'link') === Boolean(existing)) return { ticket, relatedTicket: target, changed: false };
  if (payload.action === 'link') {
    requireLinkCapacity(database, sourceNumber, targetNumber);
    if (payload.kind === 'blocks') requireNoBlockingCycle(database, ticket.id, target.id);
    database.query('INSERT INTO ticket_links VALUES (?,?,?)').run(sourceNumber, targetNumber, payload.kind);
  } else {
    database.query('DELETE FROM ticket_links WHERE source_number=? AND target_number=? AND kind=?')
      .run(sourceNumber, targetNumber, payload.kind);
  }
  const next = { ...ticket, revision: nextTicketCounter(ticket.revision), updatedAt: now };
  const relatedTicket = { ...target, revision: nextTicketCounter(target.revision), updatedAt: now };
  for (const endpoint of [next, relatedTicket]) {
    saveTicket(database, endpoint);
    appendActivity(database, endpoint.id, { action: payload.action === 'link' ? 'linked' : 'unlinked',
      kind: payload.kind, sourceId: formatTicketId(sourceNumber), targetId: formatTicketId(targetNumber) }, context, now);
  }
  return { ticket: next, relatedTicket, changed: true };
}

export function mutateTicket(database: Database, payload: TicketMutationPayload,
  context: TicketMutationContext, now: string): TicketMutationCommit {
  if (payload.action === 'create') return create(database, payload, context, now);
  const current = requireTicket(database, payload.ticketId);
  if (payload.action === 'comment') {
    return { ticket: current, comment: addComment(database, current, payload.body, context, now), changed: true };
  }
  if (payload.action === 'comment-edit' || payload.action === 'comment-delete') {
    return changeComment(database, current, payload, context, now);
  }
  requireTicketRevision(current, payload.expectedRevision);
  switch (payload.action) {
    case 'update':
      if (payload.patch.status !== undefined && current.status === 'closed') {
        throw new TicketDomainError('TICKET_INVALID_TRANSITION', 'Use reopen before changing a closed ticket status.');
      }
      return commitFields(database, current, { ...current, ...payload.patch }, 'updated', context, now);
    case 'claim':
      if (current.status === 'closed') throw new TicketDomainError('TICKET_INVALID_TRANSITION', 'A closed ticket cannot be claimed.');
      if (current.assignee && ticketOwnerKey(current.assignee) !== ticketOwnerKey(context.owner)) {
        throw new TicketDomainError('TICKET_ALREADY_CLAIMED', 'Ticket is assigned to another owner.', current);
      }
      return commitFields(database, current, { ...current, assignee: context.owner,
        status: current.status === 'open' ? 'in-progress' : current.status }, 'claimed', context, now);
    case 'release':
      if (current.assignee && ticketOwnerKey(current.assignee) !== ticketOwnerKey(context.owner)) {
        throw new TicketDomainError('TICKET_ALREADY_CLAIMED', 'Only the assigned owner can release this ticket.', current);
      }
      return commitFields(database, current, { ...current, assignee: null }, 'released', context, now);
    case 'reopen':
      if (current.status !== 'closed') return { ticket: current, changed: false };
      return commitFields(database, current, { ...current, status: 'open', resolution: null }, 'reopened', context, now);
    case 'close': {
      const resolution = payload.resolution ?? 'done';
      if (current.status === 'closed' && current.resolution !== resolution) {
        throw new TicketDomainError('TICKET_INVALID_TRANSITION', 'Reopen the ticket before changing its resolution.');
      }
      const commit = commitFields(database, current, { ...current, status: 'closed', resolution }, 'closed', context, now);
      if (payload.comment === undefined) return commit;
      return { ...commit, changed: true, comment: addComment(database, commit.ticket, payload.comment, context, now) };
    }
    case 'link': case 'unlink': return changeLink(database, current, payload, context, now);
  }
}
