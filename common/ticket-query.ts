import { TICKET_LIMITS, ticketAssigneeQuery, type TicketListQuery, type TicketReadQuery,
  type TicketCommentsQuery, type TicketHistoryQuery } from './tickets.js';
import { ticketBoolean, ticketId, ticketInteger, ticketInvalid, ticketLine, ticketOwner, ticketPriority,
  ticketProject, ticketRecord, ticketStatus, parseTicketAssigneeQuery } from './ticket-validation.js';

const listKeys = ['project', 'status', 'includeClosed', 'priority', 'label', 'assignee', 'ready',
  'query', 'beforeNumber', 'expectedCollectionRevision', 'limit'];

function optionalInteger(raw: Record<string, unknown>, key: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (raw[key] === undefined) return undefined;
  return ticketInteger(raw[key], key, minimum, maximum);
}

export function parseTicketListQuery(value: unknown): TicketListQuery {
  const raw = ticketRecord(value, listKeys);
  const beforeNumber = optionalInteger(raw, 'beforeNumber');
  const expectedCollectionRevision = optionalInteger(raw, 'expectedCollectionRevision', 0);
  requireCommentRevision(beforeNumber, expectedCollectionRevision);
  let assignee: TicketListQuery['assignee'];
  if (raw.assignee === 'unassigned') assignee = 'unassigned';
  else if (raw.assignee !== undefined) assignee = ticketOwner(raw.assignee);
  return {
    ...(raw.project !== undefined ? { project: ticketProject(raw.project) } : {}),
    ...(raw.status !== undefined ? { status: ticketStatus(raw.status) } : {}),
    ...(raw.includeClosed !== undefined ? { includeClosed: ticketBoolean(raw.includeClosed) } : {}),
    ...(raw.priority !== undefined ? { priority: ticketPriority(raw.priority) } : {}),
    ...(raw.label !== undefined ? { label: ticketLine(raw.label, 'label', TICKET_LIMITS.labelCodePoints) } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(raw.ready !== undefined ? { ready: ticketBoolean(raw.ready) } : {}),
    ...(raw.query !== undefined ? { query: ticketLine(raw.query, 'query', 256) } : {}),
    ...(beforeNumber !== undefined ? { beforeNumber } : {}),
    ...(expectedCollectionRevision !== undefined ? { expectedCollectionRevision } : {}),
    limit: optionalInteger(raw, 'limit', 1, TICKET_LIMITS.page) ?? TICKET_LIMITS.defaultPage,
  };
}

export function parseTicketReadQuery(value: unknown): TicketReadQuery {
  const raw = ticketRecord(value, ['ticketId', 'includeDescription', 'commentLimit',
    'beforeCommentSequence', 'expectedCollectionRevision']);
  const beforeCommentSequence = optionalInteger(raw, 'beforeCommentSequence');
  const expectedCollectionRevision = optionalInteger(raw, 'expectedCollectionRevision', 0);
  const commentLimit = optionalInteger(raw, 'commentLimit', 0, TICKET_LIMITS.page) ?? TICKET_LIMITS.defaultPage;
  requireCommentRevision(beforeCommentSequence, expectedCollectionRevision);
  if (beforeCommentSequence !== undefined && commentLimit === 0) return ticketInvalid('Comment continuation requires a positive limit.');
  return {
    ticketId: ticketId(raw.ticketId),
    includeDescription: raw.includeDescription === undefined ? true : ticketBoolean(raw.includeDescription),
    commentLimit,
    ...(beforeCommentSequence !== undefined ? { beforeCommentSequence } : {}),
    ...(expectedCollectionRevision !== undefined ? { expectedCollectionRevision } : {}),
  };
}

export function parseTicketCommentsQuery(value: unknown): TicketCommentsQuery {
  const raw = ticketRecord(value, ['ticketId', 'limit', 'beforeSequence', 'expectedCollectionRevision']);
  const beforeSequence = optionalInteger(raw, 'beforeSequence');
  const expectedCollectionRevision = optionalInteger(raw, 'expectedCollectionRevision', 0);
  requireCommentRevision(beforeSequence, expectedCollectionRevision);
  return { ticketId: ticketId(raw.ticketId),
    limit: optionalInteger(raw, 'limit', 1, TICKET_LIMITS.page) ?? TICKET_LIMITS.defaultPage,
    ...(beforeSequence !== undefined ? { beforeSequence } : {}),
    ...(expectedCollectionRevision !== undefined ? { expectedCollectionRevision } : {}) };
}

export function parseTicketHistoryQuery(value: unknown): TicketHistoryQuery {
  const raw = ticketRecord(value, ['ticketId', 'limit', 'beforeSequence']);
  const beforeSequence = optionalInteger(raw, 'beforeSequence');
  return { ticketId: ticketId(raw.ticketId),
    limit: optionalInteger(raw, 'limit', 1, TICKET_LIMITS.page) ?? TICKET_LIMITS.defaultPage,
    ...(beforeSequence !== undefined ? { beforeSequence } : {}) };
}

function requireCommentRevision(cursor: number | undefined, revision: number | undefined): void {
  if (cursor !== undefined && revision === undefined) return ticketInvalid('Continuation requires expectedCollectionRevision.');
}

export function ticketQueryParams(params: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, text] of params) {
    if (Object.hasOwn(raw, key)) return ticketInvalid('Duplicate query parameter.');
    if (['limit', 'priority', 'beforeNumber', 'expectedCollectionRevision', 'commentLimit',
      'beforeCommentSequence', 'beforeSequence'].includes(key)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(text)) return ticketInvalid('Invalid numeric query parameter.');
      raw[key] = Number(text);
    } else if (['includeClosed', 'ready', 'includeDescription'].includes(key)) {
      if (text !== 'true' && text !== 'false') return ticketInvalid('Invalid boolean query parameter.');
      raw[key] = text === 'true';
    } else if (key === 'assignee') {
      raw[key] = parseTicketAssigneeQuery(text);
    } else {
      Object.defineProperty(raw, key, { value: text, enumerable: true, configurable: true });
    }
  }
  return raw;
}

export function ticketSearchParams(query: TicketListQuery | TicketReadQuery | TicketCommentsQuery | TicketHistoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (key === 'assignee' && 'assignee' in query && query.assignee && query.assignee !== 'unassigned') {
      params.set(key, ticketAssigneeQuery(query.assignee));
    } else params.set(key, String(value));
  }
  return params;
}
