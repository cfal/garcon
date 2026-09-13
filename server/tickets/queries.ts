import type { Database } from 'bun:sqlite';
import { parseTicketActivity } from '../../common/ticket-records.js';
import { formatTicketId, TICKET_ID_PREFIX, ticketBytes, ticketNumber } from '../../common/ticket-validation.js';
import { TICKET_LIMITS, ticketOwnerKey, type TicketActivity, type TicketCollectionVersion,
  type TicketCommentsQuery, type TicketCommentView, type TicketCounts, type TicketDetail, type TicketFacets,
  type TicketHistoryQuery, type TicketLink, type TicketListQuery, type TicketPage, type TicketReadQuery,
  type TicketSequencePage, type TicketSummary } from '../../common/tickets.js';
import { ticketAuthorityKey, type TicketAuthority } from './contracts.js';
import { TicketDomainError } from './errors.js';
import { collectionRevision, decodeComment, decodeTicket, requireCollectionRevision, requireTicket,
  type StoredCommentRow, type StoredTicketRow } from './records.js';

export interface TicketReadBudget {
  readonly maxBytes: number;
  readonly measure: (value: unknown) => number;
}

export const HTTP_TICKET_BUDGET: TicketReadBudget = {
  maxBytes: TICKET_LIMITS.httpBytes,
  measure: (value) => ticketBytes(JSON.stringify(value)),
};

export function packTicketItems<T, R>(candidates: readonly T[], limit: number,
  build: (items: readonly T[], more: boolean) => R, budget: TicketReadBudget): R {
  const items: T[] = [];
  const empty = build(items, false);
  if (budget.measure(empty) > budget.maxBytes) throw oversized();
  for (const candidate of candidates.slice(0, limit)) {
    const next = [...items, candidate];
    if (budget.measure(build(next, candidates.length > next.length)) > budget.maxBytes) {
      if (!items.length) throw oversized();
      break;
    }
    items.push(candidate);
  }
  return build(items, candidates.length > items.length);
}

function oversized(): TicketDomainError {
  return new TicketDomainError('TICKET_RESULT_TOO_LARGE', 'Ticket content exceeds the response limit. Request less content or use another transport.');
}

const unresolvedBlockers = `SELECT count(*) FROM ticket_links bl JOIN tickets blocker ON blocker.number=bl.source_number
  WHERE bl.target_number=i.number AND bl.kind='blocks' AND NOT (blocker.status='closed' AND blocker.resolution='done')`;

function literalLike(text: string): string {
  return text.replace(/[\\%_]/gu, '\\$&');
}

function listFilter(query: TicketListQuery): { sql: string; values: (string | number)[] } {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  const add = (condition: string, value: string | number) => { conditions.push(condition); values.push(value); };
  if (query.project !== undefined) add('i.project=?', query.project);
  if (query.status !== undefined) add('i.status=?', query.status);
  else if (!query.includeClosed) conditions.push("i.status<>'closed'");
  if (query.priority !== undefined) add('i.priority=?', query.priority);
  if (query.label !== undefined) add('EXISTS(SELECT 1 FROM ticket_labels l WHERE l.ticket_number=i.number AND l.label=?)', query.label);
  if (query.assignee === 'unassigned') conditions.push('i.assignee_key IS NULL');
  else if (query.assignee) add('i.assignee_key=?', ticketOwnerKey(query.assignee));
  if (query.ready !== undefined) {
    const ready = `(i.status='open' AND i.assignee_key IS NULL AND (${unresolvedBlockers})=0)`;
    conditions.push(query.ready ? ready : `NOT ${ready}`);
  }
  if (query.query !== undefined) {
    conditions.push(`(instr(lower(json_extract(i.payload_json,'$.title')), lower(?))>0
      OR instr(lower(json_extract(i.payload_json,'$.description')), lower(?))>0 OR '${TICKET_ID_PREFIX}'||i.number=?)`);
    values.push(query.query, query.query, query.query);
  }
  if (query.beforeNumber !== undefined) add('i.number<?', query.beforeNumber);
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

export function listTickets(database: Database, storeId: string, query: TicketListQuery, budget: TicketReadBudget): TicketPage {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  const filter = listFilter(query);
  const limit = query.limit ?? TICKET_LIMITS.defaultPage;
  const rows = database.query<StoredTicketRow & { blocked_count: number; comment_count: number }, (string | number)[]>(`
    SELECT i.*, (${unresolvedBlockers}) AS blocked_count,
      (SELECT count(*) FROM ticket_comments c WHERE c.ticket_number=i.number AND c.deleted_at IS NULL) AS comment_count
    FROM tickets i ${filter.sql} ORDER BY i.number DESC LIMIT ?
  `).all(...filter.values, limit + 1);
  const summaries = rows.map((row): TicketSummary => {
    const { description: _description, ...ticket } = decodeTicket(row);
    return { ...ticket, blockedByCount: row.blocked_count, commentCount: row.comment_count };
  });
  return packTicketItems(summaries, limit, (items, more) => ({ storeId, collectionRevision, items,
    nextBeforeNumber: more ? items.at(-1)!.number : null }), budget);
}

export function countTickets(database: Database, storeId: string, query: TicketListQuery): TicketCounts {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  const filter = listFilter(query);
  const rows = database.query<{ status: keyof TicketCounts['counts']; count: number }, (string | number)[]>(
    `SELECT i.status,count(*) AS count FROM tickets i ${filter.sql} GROUP BY i.status`,
  ).all(...filter.values);
  const counts = { open: 0, 'in-progress': 0, 'in-review': 0, closed: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return { storeId, collectionRevision, counts };
}

function commentCandidates(database: Database, query: TicketCommentsQuery, authority: TicketAuthority): TicketCommentView[] {
  const rows = database.query<StoredCommentRow, number[]>(`
    SELECT * FROM ticket_comments WHERE ticket_number=? AND sequence<? ORDER BY sequence DESC LIMIT ?
  `).all(ticketNumber(query.ticketId), query.beforeSequence ?? Number.MAX_SAFE_INTEGER,
    (query.limit ?? TICKET_LIMITS.defaultPage) + 1);
  const authorityKey = ticketAuthorityKey(authority);
  return rows.map((row) => ({ ...decodeComment(row), canEdit: row.deleted_at === null && row.authority_key === authorityKey }));
}

function sequencePage<T extends { sequence: number }>(version: TicketCollectionVersion,
  items: readonly T[], more: boolean): TicketSequencePage<T> {
  return { ...version, items: [...items].reverse(), nextBeforeSequence: more ? items.at(-1)!.sequence : null };
}

export function readTicketComments(database: Database, storeId: string, query: TicketCommentsQuery,
  authority: TicketAuthority, budget: TicketReadBudget): TicketSequencePage<TicketCommentView> {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  requireTicket(database, query.ticketId);
  return packTicketItems(commentCandidates(database, query, authority), query.limit ?? TICKET_LIMITS.defaultPage,
    (items, more) => sequencePage({ storeId, collectionRevision }, items, more), budget);
}

export function readTicketDetail(database: Database, storeId: string, query: TicketReadQuery,
  authority: TicketAuthority, budget: TicketReadBudget): TicketDetail {
  const collectionRevision = requireCollectionRevision(database, query.expectedCollectionRevision);
  const current = requireTicket(database, query.ticketId);
  const ticket = { ...current, description: query.includeDescription === false ? null : current.description };
  const links = database.query<{ source_number: number; target_number: number; kind: TicketLink['kind'] }, [number, number]>(
    'SELECT * FROM ticket_links WHERE source_number=? OR target_number=? ORDER BY source_number,target_number,kind',
  ).all(current.number, current.number).map((link) => ({ sourceId: formatTicketId(link.source_number),
    targetId: formatTicketId(link.target_number), kind: link.kind }));
  const limit = query.commentLimit ?? TICKET_LIMITS.defaultPage;
  const candidates = limit === 0 ? [] : commentCandidates(database, {
    ticketId: query.ticketId, limit, beforeSequence: query.beforeCommentSequence,
  }, authority);
  const version = { storeId, collectionRevision };
  return packTicketItems(candidates, limit, (items, more) => ({ ...version, ticket, links,
    comments: sequencePage(version, items, more) }), budget);
}

export function readTicketHistory(database: Database, storeId: string, query: TicketHistoryQuery,
  budget: TicketReadBudget): TicketSequencePage<TicketActivity> {
  requireTicket(database, query.ticketId);
  const version = { storeId, collectionRevision: collectionRevision(database) };
  const limit = query.limit ?? TICKET_LIMITS.defaultPage;
  const rows = database.query<{ sequence: number; payload_json: string }, number[]>(`
    SELECT sequence,payload_json FROM ticket_activity WHERE ticket_number=? AND sequence<? ORDER BY sequence DESC LIMIT ?
  `).all(ticketNumber(query.ticketId), query.beforeSequence ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const events = rows.map((row) => {
    const activity = parseTicketActivity(JSON.parse(row.payload_json));
    if (activity.sequence !== row.sequence || activity.ticketId !== query.ticketId) throw new Error('Inconsistent ticket activity.');
    return activity;
  });
  return packTicketItems(events, limit, (items, more) => sequencePage(version, items, more), budget);
}

export function ticketFacets(database: Database, storeId: string, field: 'project' | 'label', prefix: string): TicketFacets {
  const sql = field === 'project'
    ? "SELECT DISTINCT project AS value FROM tickets WHERE project LIKE ? ESCAPE '\\' ORDER BY project LIMIT 50"
    : "SELECT DISTINCT label AS value FROM ticket_labels WHERE label LIKE ? ESCAPE '\\' ORDER BY label LIMIT 50";
  const values = database.query<{ value: string }, [string]>(sql).all(`${literalLike(prefix)}%`).map((row) => row.value);
  return { storeId, collectionRevision: collectionRevision(database), values };
}
