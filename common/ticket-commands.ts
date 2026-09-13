import type { Ticket, TicketLinkKind, TicketOwner, TicketPriority, TicketResolution, TicketStatus,
  TicketListQuery, TicketReadQuery, TicketHistoryQuery } from './tickets.js';
import { ticketBody, ticketChatId, ticketCommentBody, ticketId, ticketInteger, ticketInvalid,
  ticketLabels, ticketLinkKind, ticketOwner, ticketPriority, ticketProject, ticketRecord,
  ticketResolution, ticketStatus, ticketTitle, ticketUuid } from './ticket-validation.js';

export interface TicketCreateFields {
  readonly title: string;
  readonly description?: string;
  readonly priority?: TicketPriority;
  readonly labels?: readonly string[];
  readonly assignee?: TicketOwner | null;
  readonly parentId?: string | null;
}

export type TicketPatch = Partial<Pick<Ticket,
  'title' | 'description' | 'project' | 'priority' | 'labels' | 'assignee' | 'parentId'>>
  & { readonly status?: Exclude<TicketStatus, 'closed'> };

export interface UpdateTicketPayload {
  readonly action: 'update';
  readonly ticketId: string;
  readonly expectedRevision: number;
  readonly patch: TicketPatch;
}

export type TicketMutationPayload =
  | { readonly action: 'create'; readonly input: TicketCreateFields & { readonly project: string } }
  | UpdateTicketPayload
  | { readonly action: 'claim' | 'release' | 'reopen'; readonly ticketId: string; readonly expectedRevision: number }
  | { readonly action: 'close'; readonly ticketId: string; readonly expectedRevision: number;
      readonly resolution?: TicketResolution; readonly comment?: string }
  | { readonly action: 'comment'; readonly ticketId: string; readonly body: string }
  | { readonly action: 'comment-edit'; readonly ticketId: string; readonly commentId: string;
      readonly expectedRevision: number; readonly body: string }
  | { readonly action: 'comment-delete'; readonly ticketId: string; readonly commentId: string;
      readonly expectedRevision: number }
  | { readonly action: 'link' | 'unlink'; readonly ticketId: string; readonly expectedRevision: number;
      readonly targetId: string; readonly targetRevision: number; readonly kind: TicketLinkKind };

export type MarkupTicketMutationPayload =
  | Exclude<TicketMutationPayload, { readonly action: 'create' }>
  | { readonly action: 'create'; readonly input: TicketCreateFields & { readonly project?: string } };

export interface HttpTicketMutationRequest {
  readonly requestId: string;
  readonly expectedStoreId: string;
  readonly fromChatId?: string;
  readonly payload: TicketMutationPayload;
}

export type TicketReadPayload =
  | { readonly action: 'list'; readonly query: TicketListQuery }
  | { readonly action: 'read'; readonly query: TicketReadQuery }
  | { readonly action: 'history'; readonly query: TicketHistoryQuery };

export type TicketAction = TicketMutationPayload['action'] | TicketReadPayload['action'];
export const TICKET_ACTIONS = ['create', 'update', 'claim', 'release', 'reopen', 'close',
  'comment', 'comment-edit', 'comment-delete', 'link', 'unlink', 'list', 'read', 'history'] as const;

const createKeys = ['title', 'description', 'project', 'priority', 'labels', 'assignee', 'parentId'];
const patchKeys = [...createKeys, 'status'];

export function parseTicketPatch(value: unknown): TicketPatch {
  const raw = ticketRecord(value, patchKeys);
  if (Object.keys(raw).length === 0) return ticketInvalid('A ticket patch must not be empty.');
  const patch: TicketPatch = {
    ...(raw.title !== undefined ? { title: ticketTitle(raw.title) } : {}),
    ...(raw.description !== undefined ? { description: ticketBody(raw.description) } : {}),
    ...(raw.project !== undefined ? { project: ticketProject(raw.project) } : {}),
    ...(raw.priority !== undefined ? { priority: ticketPriority(raw.priority) } : {}),
    ...(raw.labels !== undefined ? { labels: ticketLabels(raw.labels) } : {}),
    ...(raw.assignee !== undefined ? { assignee: nullableOwner(raw.assignee) } : {}),
    ...(raw.parentId !== undefined ? { parentId: nullableTicketId(raw.parentId) } : {}),
  };
  if (raw.status === undefined) {
    if (!Object.keys(patch).length) return ticketInvalid('A ticket patch must not be empty.');
    return patch;
  }
  const status = ticketStatus(raw.status);
  if (status === 'closed') return ticketInvalid('Use close to close a ticket.');
  return { ...patch, status };
}

function nullableOwner(value: unknown): TicketOwner | null {
  return value === null ? null : ticketOwner(value);
}

function nullableTicketId(value: unknown): string | null {
  return value === null ? null : ticketId(value);
}

export function parseMarkupTicketMutationPayload(value: unknown): MarkupTicketMutationPayload {
  const raw = ticketRecord(value, ['action', 'input', 'ticketId', 'expectedRevision', 'patch',
    'resolution', 'comment', 'body', 'commentId', 'targetId', 'targetRevision', 'kind']);
  if (raw.action === 'create') {
    ticketRecord(raw, ['action', 'input']);
    const input = ticketRecord(raw.input, createKeys);
    return { action: 'create', input: {
      title: ticketTitle(input.title),
      description: input.description === undefined ? '' : ticketBody(input.description),
      priority: input.priority === undefined ? 2 : ticketPriority(input.priority),
      labels: input.labels === undefined ? [] : ticketLabels(input.labels),
      assignee: input.assignee === undefined ? null : nullableOwner(input.assignee),
      parentId: input.parentId === undefined ? null : nullableTicketId(input.parentId),
      ...(input.project !== undefined ? { project: ticketProject(input.project) } : {}),
    } };
  }
  const target = ticketId(raw.ticketId);
  if (raw.action === 'comment') {
    ticketRecord(raw, ['action', 'ticketId', 'body']);
    return { action: 'comment', ticketId: target, body: ticketCommentBody(raw.body) };
  }
  const expectedRevision = ticketInteger(raw.expectedRevision, 'expectedRevision');
  const base = { ticketId: target, expectedRevision };
  switch (raw.action) {
    case 'update':
      ticketRecord(raw, ['action', 'ticketId', 'expectedRevision', 'patch']);
      return { action: 'update', ...base, patch: parseTicketPatch(raw.patch) };
    case 'claim':
    case 'release':
    case 'reopen':
      ticketRecord(raw, ['action', 'ticketId', 'expectedRevision']);
      return { action: raw.action, ...base };
    case 'close':
      ticketRecord(raw, ['action', 'ticketId', 'expectedRevision', 'resolution', 'comment']);
      return { action: 'close', ...base,
        resolution: raw.resolution === undefined ? 'done' : ticketResolution(raw.resolution),
        ...(raw.comment !== undefined ? { comment: ticketCommentBody(raw.comment) } : {}) };
    case 'comment-edit':
      ticketRecord(raw, ['action', 'ticketId', 'expectedRevision', 'commentId', 'body']);
      return { action: 'comment-edit', ...base, commentId: ticketUuid(raw.commentId, 'commentId'),
        body: ticketCommentBody(raw.body) };
    case 'comment-delete':
      ticketRecord(raw, ['action', 'ticketId', 'expectedRevision', 'commentId']);
      return { action: 'comment-delete', ...base, commentId: ticketUuid(raw.commentId, 'commentId') };
    case 'link':
    case 'unlink':
      ticketRecord(raw, ['action', 'ticketId', 'expectedRevision', 'targetId', 'targetRevision', 'kind']);
      return { action: raw.action, ...base, targetId: ticketId(raw.targetId),
        targetRevision: ticketInteger(raw.targetRevision, 'targetRevision'), kind: ticketLinkKind(raw.kind) };
    default:
      return ticketInvalid('Unknown ticket mutation.');
  }
}

export function parseTicketMutationPayload(value: unknown): TicketMutationPayload {
  const payload = parseMarkupTicketMutationPayload(value);
  if (payload.action !== 'create') return payload;
  return { action: 'create', input: { ...payload.input, project: ticketProject(payload.input.project) } };
}

export function parseHttpTicketMutationRequest(value: unknown): HttpTicketMutationRequest {
  const raw = ticketRecord(value, ['requestId', 'expectedStoreId', 'fromChatId', 'payload']);
  return {
    requestId: ticketUuid(raw.requestId, 'requestId'),
    expectedStoreId: ticketUuid(raw.expectedStoreId, 'expectedStoreId'),
    ...(raw.fromChatId !== undefined ? { fromChatId: ticketChatId(raw.fromChatId) } : {}),
    payload: parseTicketMutationPayload(raw.payload),
  };
}
