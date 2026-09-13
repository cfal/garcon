import { TICKET_ACTIONS, parseMarkupTicketMutationPayload, type TicketAction,
  type TicketReadPayload, type MarkupTicketMutationPayload } from './ticket-commands.js';
import { parseTicketHistoryQuery, parseTicketListQuery, parseTicketReadQuery } from './ticket-query.js';
import { ticketId, ticketInteger, ticketRecord, ticketRef } from './ticket-validation.js';
import { parseGarconCommandEnvelope } from './garcon-command-envelope.js';

export interface GarconTicketMutationCommand {
  readonly type: 'ticket';
  readonly ref: string;
  readonly payload: MarkupTicketMutationPayload;
}

export interface GarconTicketReadCommand {
  readonly type: 'ticket';
  readonly ref?: string;
  readonly payload: TicketReadPayload;
}

export type GarconTicketCommand = GarconTicketMutationCommand | GarconTicketReadCommand;

export function isTicketReadAction(action: TicketAction): action is TicketReadPayload['action'] {
  return action === 'list' || action === 'read' || action === 'history';
}

export function isTicketReadCommand(command: GarconTicketCommand): command is GarconTicketReadCommand {
  return isTicketReadAction(command.payload.action);
}

function attributes(action: TicketAction): readonly string[] {
  if (action === 'create' || action === 'list') return ['ref'];
  if (action === 'read' || action === 'history' || action === 'comment') return ['ref', 'ticket-id'];
  if (action === 'comment-edit' || action === 'comment-delete') return ['ref', 'ticket-id', 'comment-id', 'expected-revision'];
  return ['ref', 'ticket-id', 'expected-revision'];
}

function revision(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error('Invalid ticket revision.');
  return ticketInteger(Number(value), 'expectedRevision');
}

export function parseGarconTicketCommand(content: string): GarconTicketCommand | null {
  const action = TICKET_ACTIONS.find((candidate) => {
    const prefix = `<garcon-ticket-${candidate}`;
    return content.startsWith(prefix) && /[\s/>]/u.test(content[prefix.length] ?? '');
  });
  if (!action) return null;
  const envelope = parseGarconCommandEnvelope(content, `garcon-ticket-${action}`, attributes(action));
  if (!envelope) return null;
  try {
    const { body, selfClosing } = envelope;
    const ref = envelope.attributes.ref === undefined ? undefined : ticketRef(envelope.attributes.ref);
    const target = action === 'create' || action === 'list' ? undefined : ticketId(envelope.attributes['ticket-id']);
    const json = () => body ? JSON.parse(body) as unknown : {};
    if (isTicketReadAction(action)) {
      let payload: TicketReadPayload;
      if (action === 'list') payload = { action, query: parseTicketListQuery(json()) };
      else if (action === 'read') {
        const query = ticketRecord(json(), ['includeDescription', 'commentLimit', 'beforeCommentSequence', 'expectedCollectionRevision']);
        payload = { action, query: parseTicketReadQuery({ ...query, ticketId: target }) };
      } else {
        const query = ticketRecord(json(), ['limit', 'beforeSequence']);
        payload = { action, query: parseTicketHistoryQuery({ ...query, ticketId: target }) };
      }
      return { type: 'ticket', ...(ref === undefined ? {} : { ref }), payload };
    }
    if (ref === undefined) return null;
    const onlySelfClosing = ['claim', 'release', 'reopen', 'comment-delete'].includes(action);
    if (onlySelfClosing && !selfClosing) return null;
    if (!onlySelfClosing && action !== 'close' && (selfClosing || !body)) return null;
    let raw: Record<string, unknown>;
    if (action === 'create') raw = { action, input: json() };
    else if (action === 'comment') raw = { action, ticketId: target, body };
    else {
      const base = { action, ticketId: target, expectedRevision: revision(envelope.attributes['expected-revision']) };
      switch (action) {
        case 'update': raw = { ...base, patch: json() }; break;
        case 'link': case 'unlink':
          raw = { ...base, ...ticketRecord(json(), ['targetId', 'targetRevision', 'kind']) }; break;
        case 'close': raw = { ...base, ...ticketRecord(json(), ['resolution', 'comment']) }; break;
        case 'comment-edit': raw = { ...base, commentId: envelope.attributes['comment-id'], body }; break;
        case 'comment-delete': raw = { ...base, commentId: envelope.attributes['comment-id'] }; break;
        default: raw = base;
      }
    }
    return { type: 'ticket', ref, payload: parseMarkupTicketMutationPayload(raw) };
  } catch { return null; }
}
