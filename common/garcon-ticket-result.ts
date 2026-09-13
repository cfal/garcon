import { TICKET_ACTIONS, type TicketAction } from './ticket-commands.js';
import type { AgentCommandCorrelation } from './garcon-command-results.js';
import { isTicketReadAction } from './garcon-ticket-command.js';
import { escapeGarconXmlText, parseGarconCommandEnvelope } from './garcon-command-envelope.js';
import { parseTicketDetail, parseTicketHistoryPage, parseTicketPage } from './ticket-responses.js';
import { ticketBytes, storedTicketId, ticketInteger, ticketInvalid, ticketRecord, ticketRef, ticketStatus, ticketUuid } from './ticket-validation.js';
import { isErrorCode } from './error-codes.js';
import { TICKET_LIMITS, type TicketActivity, type TicketDetail, type TicketErrorCode, type TicketPage,
  type TicketSequencePage, type TicketStatus, type TicketWriteResult } from './tickets.js';

export interface TicketMutationReceipt {
  readonly storeId: string;
  readonly ticketId: string;
  readonly revision: number;
  readonly status: TicketStatus;
  readonly collectionRevision: number;
  readonly comment?: { readonly id: string; readonly revision: number };
  readonly relatedTicket?: { readonly id: string; readonly revision: number };
}

type RequestIdentity<A extends TicketAction> = { readonly command: A }
  & (A extends 'list' | 'read' | 'history' ? { readonly ref?: string } : { readonly ref: string })
  & (A extends 'create' ? { readonly ticketId?: string } : A extends 'list' ? object : { readonly ticketId: string });
type SuccessIdentity<A extends TicketAction> = RequestIdentity<A> & (A extends 'create' ? { readonly ticketId: string } : unknown);
type ResultData<A extends TicketAction> = A extends 'list' ? TicketPage : A extends 'read' ? TicketDetail
  : A extends 'history' ? TicketSequencePage<TicketActivity> : TicketMutationReceipt;
export type GarconTicketResult = {
  [A in TicketAction]: AgentCommandCorrelation & (
    | SuccessIdentity<A> & { readonly status: 'ok'; readonly data: ResultData<A> }
    | RequestIdentity<A> & { readonly status: 'error'; readonly errorCode: TicketErrorCode; readonly message: string }
  )
}[TicketAction];
export type TicketCommandOutcome = {
  [A in TicketAction]: AgentCommandCorrelation & { readonly type: 'ticket-command-outcome' } & (
    | SuccessIdentity<A> & { readonly status: 'ok' }
      & (A extends 'list' | 'history' ? object : { readonly revision: number })
    | RequestIdentity<A> & { readonly status: 'error'; readonly errorCode: TicketErrorCode }
  )
}[TicketAction];

export function ticketMutationReceipt(result: TicketWriteResult): TicketMutationReceipt {
  return { storeId: result.storeId, ticketId: result.ticket.id, revision: result.ticket.revision,
    status: result.ticket.status, collectionRevision: result.collectionRevision,
    ...(result.comment ? { comment: { id: result.comment.id, revision: result.comment.revision } } : {}),
    ...(result.relatedTicket ? { relatedTicket: { id: result.relatedTicket.id, revision: result.relatedTicket.revision } } : {}) };
}

function parseReceipt(value: unknown): TicketMutationReceipt {
  const raw = ticketRecord(value, ['storeId', 'ticketId', 'revision', 'status', 'collectionRevision', 'comment', 'relatedTicket']);
  const reference = (value: unknown, kind: 'comment' | 'ticket') => {
    const raw = ticketRecord(value, ['id', 'revision']);
    return { id: kind === 'comment' ? ticketUuid(raw.id, 'commentId') : storedTicketId(raw.id), revision: ticketInteger(raw.revision, 'revision') };
  };
  return { storeId: ticketUuid(raw.storeId, 'storeId'), ticketId: storedTicketId(raw.ticketId),
    revision: ticketInteger(raw.revision, 'revision'), status: ticketStatus(raw.status),
    collectionRevision: ticketInteger(raw.collectionRevision, 'collectionRevision', 0),
    ...(raw.comment === undefined ? {} : { comment: reference(raw.comment, 'comment') }),
    ...(raw.relatedTicket === undefined ? {} : { relatedTicket: reference(raw.relatedTicket, 'ticket') }) };
}

function requestIdentity(raw: Record<string, unknown>) {
  if (!TICKET_ACTIONS.includes(raw.command as TicketAction)) return ticketInvalid('Invalid ticket result command.');
  const command = raw.command as TicketAction;
  const ref = raw.ref === undefined && isTicketReadAction(command) ? undefined : ticketRef(raw.ref);
  if (command === 'list' && raw.ticketId !== undefined) return ticketInvalid('List result cannot target a ticket.');
  const target = raw.ticketId === undefined && (command === 'create' || command === 'list') ? undefined : storedTicketId(raw.ticketId);
  return { command, ...(ref === undefined ? {} : { ref }), ...(target === undefined ? {} : { ticketId: target }),
    requestViewId: ticketUuid(raw.requestViewId, 'requestViewId'), requestOrdinal: ticketInteger(raw.requestOrdinal, 'requestOrdinal') };
}

export function parseTicketErrorCode(value: unknown): TicketErrorCode {
  if (!isErrorCode(value) || !value.startsWith('TICKET_')) return ticketInvalid('Invalid ticket error code.');
  return value as TicketErrorCode;
}

export function parseTicketCommandResult(value: unknown): GarconTicketResult {
  const raw = ticketRecord(value, ['command', 'ref', 'ticketId', 'requestViewId', 'requestOrdinal', 'status', 'data', 'errorCode', 'message']);
  const identity = requestIdentity(raw);
  if (raw.status === 'error') {
    if (raw.data !== undefined) return ticketInvalid('A ticket error cannot contain result data.');
    if (typeof raw.message !== 'string' || !raw.message.isWellFormed() || ticketBytes(raw.message) > 2048 || !raw.message.trim()) {
      return ticketInvalid('Invalid ticket error message.');
    }
    return { ...identity, status: 'error', errorCode: parseTicketErrorCode(raw.errorCode), message: raw.message } as GarconTicketResult;
  }
  if (raw.status !== 'ok' || raw.errorCode !== undefined || raw.message !== undefined) return ticketInvalid('Invalid ticket result status.');
  let data: TicketPage | TicketDetail | TicketSequencePage<TicketActivity> | TicketMutationReceipt;
  switch (identity.command) {
    case 'list': data = parseTicketPage(raw.data); break;
    case 'read':
      data = parseTicketDetail(raw.data);
      if (data.ticket.id !== identity.ticketId) return ticketInvalid('Read result targets another ticket.');
      break;
    case 'history':
      data = parseTicketHistoryPage(raw.data);
      if (data.items.some((entry) => entry.ticketId !== identity.ticketId)) return ticketInvalid('History result targets another ticket.');
      break;
    default:
      data = parseReceipt(raw.data);
      if (data.ticketId !== identity.ticketId) return ticketInvalid('Mutation result targets another ticket.');
  }
  return { ...identity, status: 'ok', data } as GarconTicketResult;
}

const ATTRIBUTES = { command: 'command', ref: 'ref', 'ticket-id': 'ticketId',
  'request-view-id': 'requestViewId', 'request-ordinal': 'requestOrdinal', status: 'status' } as const;

export function garconTicketResultContent(result: GarconTicketResult): string {
  const attributes = Object.entries(ATTRIBUTES).flatMap(([name, key]) => {
    const value = key === 'ticketId' ? ('ticketId' in result ? result.ticketId : undefined) : result[key];
    if (key === 'command' || value === undefined) return [];
    return [`${name}="${escapeGarconXmlText(String(value)).replaceAll('"', '&quot;')}"`];
  });
  const data = result.status === 'ok' ? result.data : { errorCode: result.errorCode, message: result.message };
  const name = `garcon-ticket-${result.command}-result`;
  return `<${name} ${attributes.join(' ')}>\n${escapeGarconXmlText(JSON.stringify(data))}\n</${name}>`;
}

export function parseGarconTicketResult(content: string): GarconTicketResult | null {
  const value = content.trim();
  if (ticketBytes(value) > TICKET_LIMITS.markupBytes) return null;
  for (const command of TICKET_ACTIONS) {
    const name = `garcon-ticket-${command}-result`;
    const envelope = parseGarconCommandEnvelope(value, name, Object.keys(ATTRIBUTES).filter((key) => key !== 'command'));
    if (!envelope || envelope.selfClosing) continue;
    try {
      const raw: Record<string, unknown> = { command };
      for (const [attribute, key] of Object.entries(ATTRIBUTES)) {
        if (key === 'command') continue;
        const field = envelope.attributes[attribute];
        if (field !== undefined) raw[key] = field;
      }
      if (typeof raw.requestOrdinal !== 'string' || !/^[1-9][0-9]*$/u.test(raw.requestOrdinal)) return null;
      raw.requestOrdinal = Number(raw.requestOrdinal);
      const data: unknown = JSON.parse(envelope.body);
      if (raw.status === 'error') Object.assign(raw, ticketRecord(data, ['errorCode', 'message']));
      else raw.data = data;
      return parseTicketCommandResult(raw);
    } catch { return null; }
  }
  return null;
}

export function ticketCommandOutcome(result: GarconTicketResult): TicketCommandOutcome {
  const { requestViewId, requestOrdinal, command, ref } = result;
  const ticketId = 'ticketId' in result ? result.ticketId : undefined;
  const identity = { type: 'ticket-command-outcome' as const, requestViewId, requestOrdinal, command,
    ...(ref === undefined ? {} : { ref }), ...(ticketId === undefined ? {} : { ticketId }) };
  if (result.status === 'error') return { ...identity, status: 'error', errorCode: result.errorCode } as TicketCommandOutcome;
  let revision: number | undefined;
  if (result.command === 'read') revision = result.data.ticket.revision;
  else if ('revision' in result.data) revision = result.data.revision;
  return { ...identity, status: 'ok', ...(revision === undefined ? {} : { revision }) } as TicketCommandOutcome;
}

export function parseTicketCommandOutcome(value: unknown): TicketCommandOutcome | null {
  try {
    const raw = ticketRecord(value, ['type', 'command', 'ref', 'ticketId', 'requestViewId', 'requestOrdinal', 'status', 'revision', 'errorCode']);
    if (raw.type !== 'ticket-command-outcome') return null;
    const identity = { type: 'ticket-command-outcome' as const, ...requestIdentity(raw) };
    if (raw.status === 'error' && raw.revision === undefined) {
      return { ...identity, status: 'error', errorCode: parseTicketErrorCode(raw.errorCode) } as TicketCommandOutcome;
    }
    if (raw.status !== 'ok' || raw.errorCode !== undefined) return null;
    if (identity.command === 'list' || identity.command === 'history') {
      if (raw.revision !== undefined) return null;
      return { ...identity, status: 'ok' } as TicketCommandOutcome;
    }
    if (!identity.ticketId) return null;
    return { ...identity, status: 'ok', revision: ticketInteger(raw.revision, 'revision') } as TicketCommandOutcome;
  } catch { return null; }
}

export function ticketCommandOutcomeContent(detail: TicketCommandOutcome): string {
  if (detail.status === 'error') return `Ticket ${detail.command} failed: ${detail.errorCode}.`;
  return `Ticket ${detail.command} completed${'ticketId' in detail && detail.ticketId ? ` for ${detail.ticketId}` : ''}.`;
}
