import type { Database } from 'bun:sqlite';
import { parseTicket, parseTicketComment, parseTicketWriteResult } from '../../common/ticket-records.js';
import { ticketNumber } from '../../common/ticket-validation.js';
import { ticketOwnerKey, type Ticket, type TicketActivity, type TicketComment, type TicketWriteResult } from '../../common/tickets.js';
import { TicketDomainError, nextTicketCounter } from './errors.js';
import type { TicketMutationContext } from './contracts.js';

export interface StoredTicketRow {
  number: number;
  revision: number;
  project: string;
  status: string;
  resolution: string | null;
  priority: number;
  assignee_key: string | null;
  parent_number: number | null;
  payload_json: string;
}

export interface StoredCommentRow {
  id: string;
  ticket_number: number;
  sequence: number;
  revision: number;
  authority_key: string;
  deleted_at: string | null;
  payload_json: string;
}

export function decodeTicket(row: StoredTicketRow): Ticket {
  const ticket = parseTicket(JSON.parse(row.payload_json));
  const assignee = ticket.assignee ? ticketOwnerKey(ticket.assignee) : null;
  const parent = ticket.parentId ? ticketNumber(ticket.parentId) : null;
  if (ticket.number !== row.number || ticket.revision !== row.revision || ticket.project !== row.project
    || ticket.status !== row.status || ticket.resolution !== row.resolution || ticket.priority !== row.priority
    || assignee !== row.assignee_key || parent !== row.parent_number) throw new Error('Inconsistent ticket record.');
  return ticket;
}

export function requireTicket(database: Database, id: string): Ticket {
  const row = database.query<StoredTicketRow, [number]>('SELECT * FROM tickets WHERE number=?').get(ticketNumber(id));
  if (!row) throw new TicketDomainError('TICKET_NOT_FOUND', 'Ticket not found.');
  return decodeTicket(row);
}

export function requireTicketRevision(ticket: Ticket, revision: number): void {
  if (ticket.revision !== revision) throw new TicketDomainError('TICKET_REVISION_CONFLICT', 'Ticket changed. Read it before retrying.', ticket);
}

export function collectionRevision(database: Database): number {
  const row = database.query<{ revision: number }, []>('SELECT revision FROM ticket_meta WHERE singleton=1').get();
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid ticket revision.');
  return row.revision;
}

export function requireCollectionRevision(database: Database, expected: number | undefined): number {
  const revision = collectionRevision(database);
  if (expected !== undefined && expected !== revision) {
    throw new TicketDomainError('TICKET_COLLECTION_CHANGED', 'Tickets changed. Refresh before loading the next page.');
  }
  return revision;
}

export function saveTicket(database: Database, ticket: Ticket): void {
  database.query(`UPDATE tickets SET revision=?, project=?, status=?, resolution=?, priority=?,
    assignee_key=?, parent_number=?, payload_json=? WHERE number=?`).run(
    ticket.revision, ticket.project, ticket.status, ticket.resolution, ticket.priority,
    ticket.assignee ? ticketOwnerKey(ticket.assignee) : null,
    ticket.parentId ? ticketNumber(ticket.parentId) : null, JSON.stringify(ticket), ticket.number,
  );
  database.query('DELETE FROM ticket_labels WHERE ticket_number=?').run(ticket.number);
  const insert = database.query('INSERT INTO ticket_labels VALUES (?, ?)');
  for (const label of ticket.labels) insert.run(ticket.number, label);
}

export function nextAutoincrement(database: Database, table: 'tickets' | 'ticket_activity'): number {
  const row = database.query<{ seq: number }, [string]>('SELECT seq FROM sqlite_sequence WHERE name=?').get(table);
  return nextTicketCounter(row?.seq ?? 0);
}

export function decodeComment(row: StoredCommentRow): TicketComment {
  const comment = parseTicketComment(JSON.parse(row.payload_json));
  if (comment.id !== row.id || ticketNumber(comment.ticketId) !== row.ticket_number
    || comment.sequence !== row.sequence || comment.revision !== row.revision || comment.deletedAt !== row.deleted_at) {
    throw new Error('Inconsistent ticket comment.');
  }
  return comment;
}

export function requireComment(database: Database, id: string, ticketId: string): StoredCommentRow {
  const row = database.query<StoredCommentRow, [string]>('SELECT * FROM ticket_comments WHERE id=?').get(id);
  if (!row || row.ticket_number !== ticketNumber(ticketId)) {
    throw new TicketDomainError('TICKET_COMMENT_NOT_FOUND', 'Comment not found on this ticket.');
  }
  return row;
}

export function insertComment(database: Database, comment: TicketComment, authorityKey: string): void {
  database.query(`INSERT INTO ticket_comments
    (id,ticket_number,sequence,revision,authority_key,deleted_at,payload_json) VALUES (?,?,?,?,?,?,?)`).run(
    comment.id, ticketNumber(comment.ticketId), comment.sequence, comment.revision, authorityKey,
    comment.deletedAt, JSON.stringify(comment),
  );
}

export function updateComment(database: Database, comment: TicketComment): void {
  database.query('UPDATE ticket_comments SET revision=?, deleted_at=?, payload_json=? WHERE id=?')
    .run(comment.revision, comment.deletedAt, JSON.stringify(comment), comment.id);
}

type ActivityContent = TicketActivity extends infer T
  ? T extends TicketActivity ? Omit<T, 'sequence' | 'ticketId' | 'at' | 'actor' | 'source'> : never : never;

export function appendActivity(database: Database, ticketId: string, content: ActivityContent,
  context: TicketMutationContext, now: string): void {
  const sequence = nextAutoincrement(database, 'ticket_activity');
  const activity: TicketActivity = { ...content, sequence, ticketId, at: now, actor: context.actor, source: context.source };
  database.query('INSERT INTO ticket_activity (sequence,ticket_number,operation_key,payload_json) VALUES (?,?,?,?)')
    .run(sequence, ticketNumber(ticketId), context.operationKey, JSON.stringify(activity));
}

export function readOperation(database: Database, context: TicketMutationContext): TicketWriteResult | null {
  const row = database.query<{ fingerprint: string; result_json: string }, [string]>(
    'SELECT fingerprint,result_json FROM ticket_operations WHERE operation_key=?',
  ).get(context.operationKey);
  if (!row) return null;
  if (row.fingerprint !== context.fingerprint) throw new TicketDomainError('TICKET_REQUEST_CONFLICT', 'This request identity was already used for different ticket content.');
  const result = parseTicketWriteResult(JSON.parse(row.result_json));
  if (result.storeId !== context.expectedStoreId) throw new Error('Inconsistent ticket operation store.');
  return result;
}
