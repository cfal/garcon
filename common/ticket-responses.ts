import { parseTicket, parseTicketActivity, parseTicketComment } from './ticket-records.js';
import { ticketBoolean, storedTicketId, ticketInteger, ticketInvalid, ticketLinkKind, ticketProject,
  ticketRecord, ticketString, ticketUuid } from './ticket-validation.js';
import { TICKET_LIMITS, TICKET_STATUSES, type TicketActivity, type TicketBootstrap, type TicketCollectionVersion,
  type TicketCommentView, type TicketCounts, type TicketDetail, type TicketFacets, type TicketLink,
  type TicketPage, type TicketProjectDefault, type TicketSequencePage, type TicketSummary } from './tickets.js';

function version(raw: Record<string, unknown>): TicketCollectionVersion {
  return { storeId: ticketUuid(raw.storeId, 'storeId'),
    collectionRevision: ticketInteger(raw.collectionRevision, 'collectionRevision', 0) };
}

function items<T>(value: unknown, parse: (item: unknown) => T, max: number = TICKET_LIMITS.page): T[] {
  if (!Array.isArray(value) || value.length > max) return ticketInvalid('Invalid ticket response items.');
  return value.map(parse);
}

function cursor(value: unknown): number | null {
  return value === null ? null : ticketInteger(value, 'continuation');
}

export function parseTicketBootstrap(value: unknown): TicketBootstrap {
  const raw = ticketRecord(value, ['storeId', 'collectionRevision', 'viewerKey']);
  const viewerKey = ticketString(raw.viewerKey, 'viewerKey');
  if (!viewerKey || viewerKey.length > 2048) return ticketInvalid('Invalid viewer identity.');
  return { ...version(raw), viewerKey };
}

export function parseTicketSummary(value: unknown): TicketSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ticketInvalid('Invalid ticket summary.');
  const { blockedByCount, commentCount, ...raw } = value as Record<string, unknown>;
  if (Object.hasOwn(raw, 'description')) return ticketInvalid('Ticket summary contains a description.');
  const { description: _description, ...ticket } = parseTicket({ ...raw, description: '' });
  return { ...ticket, blockedByCount: ticketInteger(blockedByCount, 'blockedByCount', 0, TICKET_LIMITS.links),
    commentCount: ticketInteger(commentCount, 'commentCount', 0) };
}

export function parseTicketPage(value: unknown): TicketPage {
  const raw = ticketRecord(value, ['storeId', 'collectionRevision', 'items', 'nextBeforeNumber']);
  const entries = items(raw.items, parseTicketSummary);
  const nextBeforeNumber = cursor(raw.nextBeforeNumber);
  if (entries.some((entry, index) => index > 0 && entry.number >= entries[index - 1]!.number)
    || (nextBeforeNumber !== null && nextBeforeNumber !== entries.at(-1)?.number)) {
    return ticketInvalid('Invalid ticket page ordering or continuation.');
  }
  return { ...version(raw), items: entries, nextBeforeNumber };
}

export function parseTicketCommentView(value: unknown): TicketCommentView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ticketInvalid('Invalid comment view.');
  const { canEdit, ...raw } = value as Record<string, unknown>;
  const comment = parseTicketComment(raw);
  const editable = ticketBoolean(canEdit);
  if (editable && comment.deletedAt !== null) return ticketInvalid('A removed comment cannot be editable.');
  return { ...comment, canEdit: editable };
}

function sequencePage<T extends { sequence: number; ticketId: string }>(value: unknown,
  parse: (item: unknown) => T): TicketSequencePage<T> {
  const raw = ticketRecord(value, ['storeId', 'collectionRevision', 'items', 'nextBeforeSequence']);
  const entries = items(raw.items, parse);
  const nextBeforeSequence = cursor(raw.nextBeforeSequence);
  if (entries.some((entry, index) => entry.ticketId !== entries[0]!.ticketId
    || (index > 0 && entry.sequence <= entries[index - 1]!.sequence))
    || (nextBeforeSequence !== null && nextBeforeSequence !== entries[0]?.sequence)) {
    return ticketInvalid('Invalid ticket sequence ordering or continuation.');
  }
  return { ...version(raw), items: entries, nextBeforeSequence };
}

export function parseTicketCommentsPage(value: unknown): TicketSequencePage<TicketCommentView> {
  return sequencePage(value, parseTicketCommentView);
}

export function parseTicketHistoryPage(value: unknown): TicketSequencePage<TicketActivity> {
  return sequencePage(value, parseTicketActivity);
}

function parseLink(value: unknown): TicketLink {
  const raw = ticketRecord(value, ['sourceId', 'targetId', 'kind']);
  const sourceId = storedTicketId(raw.sourceId);
  const targetId = storedTicketId(raw.targetId);
  if (sourceId === targetId) return ticketInvalid('Invalid self link.');
  return { sourceId, targetId, kind: ticketLinkKind(raw.kind) };
}

export function parseTicketDetail(value: unknown): TicketDetail {
  const raw = ticketRecord(value, ['storeId', 'collectionRevision', 'ticket', 'links', 'comments']);
  if (!raw.ticket || typeof raw.ticket !== 'object' || Array.isArray(raw.ticket)) return ticketInvalid('Invalid ticket detail.');
  const ticketRaw = raw.ticket as Record<string, unknown>;
  const omitted = ticketRaw.description === null;
  const current = parseTicket(omitted ? { ...ticketRaw, description: '' } : ticketRaw);
  const ticket = { ...current, description: omitted ? null : current.description };
  const collection = version(raw);
  const comments = parseTicketCommentsPage(raw.comments);
  const links = items(raw.links, parseLink, TICKET_LIMITS.links);
  if (comments.storeId !== collection.storeId || comments.collectionRevision !== collection.collectionRevision
    || comments.items.some((comment) => comment.ticketId !== ticket.id)
    || links.some((link) => link.sourceId !== ticket.id && link.targetId !== ticket.id)) {
    return ticketInvalid('Ticket detail projections disagree.');
  }
  return { ...collection, ticket, links, comments };
}

export function parseTicketCounts(value: unknown): TicketCounts {
  const raw = ticketRecord(value, ['storeId', 'collectionRevision', 'counts']);
  const counts = ticketRecord(raw.counts, TICKET_STATUSES);
  return { ...version(raw), counts: { open: ticketInteger(counts.open, 'open', 0),
    'in-progress': ticketInteger(counts['in-progress'], 'in-progress', 0),
    'in-review': ticketInteger(counts['in-review'], 'in-review', 0),
    closed: ticketInteger(counts.closed, 'closed', 0) } };
}

export function parseTicketFacets(value: unknown): TicketFacets {
  const raw = ticketRecord(value, ['storeId', 'collectionRevision', 'values']);
  return { ...version(raw), values: items(raw.values, ticketProject, 50) };
}

export function parseTicketProjectDefault(value: unknown): TicketProjectDefault {
  const raw = ticketRecord(value, ['project', 'kind']);
  if (raw.kind !== 'repository' && raw.kind !== 'folder') return ticketInvalid('Invalid project provenance.');
  return { project: ticketProject(raw.project), kind: raw.kind };
}
