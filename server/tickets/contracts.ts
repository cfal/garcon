import { createHash } from 'node:crypto';
import type { MarkupTicketMutationPayload, TicketMutationPayload } from '../../common/ticket-commands.js';
import type { TicketActor, TicketOwner, TicketSource } from '../../common/tickets.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import { ticketActor, ticketInvalid, ticketOwner } from '../../common/ticket-validation.js';
import { validateTicketInput } from './errors.js';

export type TicketAuthority =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'principal'; readonly mode: 'authenticated' | 'local'; readonly key: string };

export interface TicketCaller {
  readonly authority: TicketAuthority;
  readonly actor: TicketActor;
  readonly owner: TicketOwner;
}

export interface TicketMutationContext extends TicketCaller {
  readonly expectedStoreId: string;
  readonly source: TicketSource | null;
  readonly operationKey: string;
  readonly fingerprint: string;
}

export function ticketAuthorityKey(authority: TicketAuthority): string {
  if (authority.kind === 'chat') return JSON.stringify(['chat', authority.chatId]);
  return JSON.stringify(['principal', authority.mode, authority.key]);
}

export function deriveTicketCaller(principal: ServerPrincipal, fromChatId?: string): TicketCaller {
  const actor: TicketActor = { kind: 'user', username: principal.username,
    principalMode: principal.mode, declaredChatId: fromChatId ?? null };
  const authority: TicketAuthority = { kind: 'principal', mode: principal.mode, key: principal.key };
  const owner: TicketOwner = fromChatId
    ? { kind: 'chat', chatId: fromChatId }
    : { kind: 'user', username: principal.username };
  return validateTicketCaller({ actor, authority, owner });
}

export function validateTicketCaller(caller: TicketCaller): TicketCaller {
  return validateTicketInput(() => {
    const actor = ticketActor(caller.actor);
    const owner = ticketOwner(caller.owner);
    if (actor.kind === 'user' && caller.actor.kind === 'user' && actor.username !== caller.actor.username) {
      return ticketInvalid('The authenticated username must be a canonical ticket identity.');
    }
    return { authority: caller.authority, actor, owner };
  });
}

export function ticketFingerprint(payload: TicketMutationPayload | MarkupTicketMutationPayload, actor: TicketActor): string {
  return createHash('sha256').update(JSON.stringify([payload, actor])).digest('hex');
}

export function markupTicketContext(expectedStoreId: string, source: TicketSource,
  ref: string, payload: MarkupTicketMutationPayload): TicketMutationContext {
  const actor: TicketActor = { kind: 'chat', chatId: source.chatId, provenance: 'observed' };
  return { actor, authority: { kind: 'chat', chatId: source.chatId },
    owner: { kind: 'chat', chatId: source.chatId }, expectedStoreId, source,
    operationKey: JSON.stringify(['markup', source.chatId, ref]), fingerprint: ticketFingerprint(payload, actor) };
}
