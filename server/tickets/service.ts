import { parseHttpTicketMutationRequest, parseTicketMutationPayload, type HttpTicketMutationRequest,
  type TicketMutationPayload } from '../../common/ticket-commands.js';
import { parseTicketCommentsQuery, parseTicketHistoryQuery, parseTicketListQuery, parseTicketReadQuery } from '../../common/ticket-query.js';
import { ticketInteger, ticketRecord, ticketString } from '../../common/ticket-validation.js';
import type { TicketBootstrap, TicketOwner, TicketWriteResult } from '../../common/tickets.js';
import { createLogger } from '../lib/log.js';
import { ticketAuthorityKey, ticketFingerprint, validateTicketCaller, type TicketAuthority, type TicketCaller, type TicketMutationContext } from './contracts.js';
import { TicketDomainError, nextTicketCounter, validateTicketInput } from './errors.js';
import { mutateTicket } from './mutations.js';
import { countTickets, HTTP_TICKET_BUDGET, ticketFacets, listTickets, readTicketComments,
  readTicketDetail, readTicketHistory, type TicketReadBudget } from './queries.js';
import { collectionRevision, readOperation } from './records.js';
import { TicketStore } from './store.js';

const logger = createLogger('tickets');

export interface TicketServiceOptions {
  readonly chatExists: (chatId: string) => boolean;
  readonly commandsEnabled: () => boolean;
  readonly onInvalidated?: (revision: number) => void;
  readonly now?: () => string;
}

export class TicketService {
  constructor(private readonly store: TicketStore, private readonly options: TicketServiceOptions) {}

  get storeId(): string { return this.store.storeId; }

  bootstrap(authority: TicketAuthority): TicketBootstrap {
    return this.store.read((database) => ({ storeId: this.storeId, collectionRevision: collectionRevision(database),
      viewerKey: ticketAuthorityKey(authority) }));
  }

  lookupOperation(context: TicketMutationContext): TicketWriteResult | null {
    this.#admit(context);
    return this.store.read((database) => readOperation(database, context));
  }

  executeHttp(value: HttpTicketMutationRequest, caller: TicketCaller, signal?: AbortSignal): TicketWriteResult {
    const request = validateTicketInput(() => parseHttpTicketMutationRequest(value));
    if (caller.actor.kind !== 'user' || caller.actor.declaredChatId !== (request.fromChatId ?? null)) {
      throw new TicketDomainError('TICKET_UNAUTHORIZED', 'Ticket caller does not match the authenticated request.');
    }
    const context: TicketMutationContext = { ...caller, expectedStoreId: request.expectedStoreId, source: null,
      operationKey: JSON.stringify(['http', ticketAuthorityKey(caller.authority), request.requestId]),
      fingerprint: ticketFingerprint(request.payload, caller.actor) };
    signal?.throwIfAborted();
    return this.execute(request.payload, context);
  }

  execute(value: TicketMutationPayload, inputContext: TicketMutationContext): TicketWriteResult {
    const payload = validateTicketInput(() => parseTicketMutationPayload(value));
    const context = { ...inputContext, ...validateTicketCaller(inputContext) };
    this.#admit(context);
    const committed = this.store.transaction((database) => {
      this.#admit(context);
      const previous = readOperation(database, context);
      if (previous) return { result: previous, changed: false };
      this.#requireReferences(payload, context);
      const now = this.options.now?.() ?? new Date().toISOString();
      const change = mutateTicket(database, payload, context, now);
      let revision = collectionRevision(database);
      if (change.changed) {
        revision = nextTicketCounter(revision);
        database.query('UPDATE ticket_meta SET revision=? WHERE singleton=1').run(revision);
      }
      const result: TicketWriteResult = { success: true, storeId: this.storeId, collectionRevision: revision,
        ticket: change.ticket, ...(change.comment ? { comment: change.comment } : {}),
        ...(change.relatedTicket ? { relatedTicket: change.relatedTicket } : {}) };
      database.query('INSERT INTO ticket_operations VALUES (?,?,?)')
        .run(context.operationKey, context.fingerprint, JSON.stringify(result));
      return { result, changed: change.changed };
    });
    if (committed.changed) {
      try { this.options.onInvalidated?.(committed.result.collectionRevision); }
      catch { logger.warn('Ticket invalidation listener failed after commit.'); }
    }
    return committed.result;
  }

  list(value: unknown, budget: TicketReadBudget = HTTP_TICKET_BUDGET) {
    const query = validateTicketInput(() => parseTicketListQuery(value));
    return this.store.read((database) => listTickets(database, this.storeId, query, budget));
  }

  counts(value: unknown) {
    const query = validateTicketInput(() => {
      ticketRecord(value, ['project', 'status', 'includeClosed', 'priority', 'label', 'assignee', 'ready', 'query', 'expectedCollectionRevision']);
      return parseTicketListQuery(value);
    });
    return this.store.read((database) => countTickets(database, this.storeId, query));
  }

  read(value: unknown, authority: TicketAuthority, budget: TicketReadBudget = HTTP_TICKET_BUDGET) {
    const query = validateTicketInput(() => parseTicketReadQuery(value));
    return this.store.read((database) => readTicketDetail(database, this.storeId, query, authority, budget));
  }

  comments(value: unknown, authority: TicketAuthority, budget: TicketReadBudget = HTTP_TICKET_BUDGET) {
    const query = validateTicketInput(() => parseTicketCommentsQuery(value));
    return this.store.read((database) => readTicketComments(database, this.storeId, query, authority, budget));
  }

  history(value: unknown, budget: TicketReadBudget = HTTP_TICKET_BUDGET) {
    const query = validateTicketInput(() => parseTicketHistoryQuery(value));
    return this.store.read((database) => readTicketHistory(database, this.storeId, query, budget));
  }

  facets(field: 'project' | 'label', prefix: string) {
    validateTicketInput(() => {
      if (field !== 'project' && field !== 'label') throw new TicketDomainError('TICKET_VALIDATION_FAILED', 'Unknown ticket facet.');
      ticketString(prefix, 'prefix');
      ticketInteger(Array.from(prefix).length, 'prefix length', 0, 4096);
    });
    return this.store.read((database) => ticketFacets(database, this.storeId, field, prefix));
  }

  close(): void { this.store.close(); }

  #admit(context: TicketMutationContext): void {
    if (context.expectedStoreId !== this.storeId) {
      throw new TicketDomainError('TICKET_STORE_CHANGED', 'Ticket storage changed. Preserve the draft and refresh before creating a new request.');
    }
    if ((context.actor.kind === 'chat' || context.actor.declaredChatId !== null) && !this.options.commandsEnabled()) {
      throw new TicketDomainError('TICKET_COMMANDS_DISABLED', 'Agent ticket commands are disabled.');
    }
  }

  #requireReferences(payload: TicketMutationPayload, context: TicketMutationContext): void {
    if (context.actor.kind === 'user' && context.actor.declaredChatId) this.#requireChat(context.actor.declaredChatId);
    if (context.actor.kind === 'chat') this.#requireChat(context.actor.chatId);
    if (payload.action === 'claim' || payload.action === 'release') this.#requireOwner(context.owner, context);
    if (payload.action === 'create' && payload.input.assignee) this.#requireOwner(payload.input.assignee, context);
    if (payload.action === 'update' && payload.patch.assignee) this.#requireOwner(payload.patch.assignee, context);
  }

  #requireOwner(owner: TicketOwner, context: TicketMutationContext): void {
    if (owner.kind === 'chat') return this.#requireChat(owner.chatId);
    if (context.actor.kind !== 'user' || owner.username !== context.actor.username) {
      throw new TicketDomainError('TICKET_VALIDATION_FAILED', 'A user assignment must name the current authenticated user.');
    }
  }

  #requireChat(chatId: string): void {
    if (!this.options.chatExists(chatId)) throw new TicketDomainError('TICKET_CHAT_NOT_FOUND', 'The assigned or declared chat no longer exists.');
  }
}
