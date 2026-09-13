import { isTicketReadCommand, type GarconTicketCommand, type GarconTicketMutationCommand,
  type GarconTicketReadCommand } from '../../common/garcon-ticket-command.js';
import { garconTicketResultContent, ticketCommandOutcome, ticketCommandContext,
  ticketMutationReceipt, parseTicketCommandResult, type GarconTicketResult } from '../../common/garcon-ticket-result.js';
import { parseMarkupTicketMutationPayload } from '../../common/ticket-commands.js';
import { ticketCommandNoticeText } from '../../common/ticket-command-notice.js';
import { ticketBytes } from '../../common/ticket-validation.js';
import { TICKET_LIMITS, type TicketProjectDefault } from '../../common/tickets.js';
import { AgentCommandReplies, type AgentCommandContext } from '../chats/agent-command-replies.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { markupTicketContext, type TicketMutationContext } from './contracts.js';
import { TicketDomainError, validateTicketInput } from './errors.js';
import { resolveTicketProjectDefault } from './project-default.js';
import type { TicketReadBudget } from './queries.js';
import type { TicketRuntime } from './setup.js';

export interface TicketCommandControllerOptions extends AgentCommandContext {
  readonly tickets: Pick<TicketRuntime, 'service'>;
  readonly resolveProject?: (directory: string, signal: AbortSignal) => Promise<TicketProjectDefault>;
}

export class TicketCommandController {
  readonly #replies: AgentCommandReplies;

  constructor(private readonly options: TicketCommandControllerOptions) {
    this.#replies = new AgentCommandReplies(options);
  }

  request(source: AgentCommandSource, command: GarconTicketCommand): void {
    let capturedStore: { storeId: string } | { error: unknown };
    try { capturedStore = { storeId: this.options.tickets.service.storeId }; }
    catch (error) { capturedStore = { error }; }
    this.#replies.launch(source, async (signal) => {
      let result: GarconTicketResult;
      try {
        if ('error' in capturedStore) throw capturedStore.error;
        result = isTicketReadCommand(command)
          ? await this.#locked(source, signal, capturedStore.storeId, () => this.#read(source, command))
          : await this.#mutate(source, command, signal, capturedStore.storeId);
      } catch (error) {
        if (signal.aborted) return;
        const failure = error instanceof TicketDomainError ? error
          : new TicketDomainError('TICKET_INTERNAL_ERROR', 'The ticket command could not complete. Retry with the same ref to confirm its outcome.');
        this.#replies.report(source, 'ticket-command', failure);
        result = parseTicketCommandResult({ ...identity(source, command), status: 'error',
          errorCode: failure.code, message: failure.message });
      }
      await this.#reply(source, result, signal);
    });
  }

  discardSource(chatId: string): void { this.#replies.discardSource(chatId); }
  shutdown(): void { this.#replies.shutdown(); }

  #locked<T>(source: AgentCommandSource, signal: AbortSignal, storeId: string, operation: () => T): Promise<T> {
    return this.options.chatMutationLock.runExclusive(`chat:${source.chatId}`, async () => {
      signal.throwIfAborted();
      if (!this.#replies.current(source, signal)) throw sourceUnavailable();
      if (!this.options.isEnabled()) throw new TicketDomainError('TICKET_COMMANDS_DISABLED', 'Agent ticket commands are disabled.');
      if (this.options.tickets.service.storeId !== storeId) {
        throw new TicketDomainError('TICKET_STORE_CHANGED', 'Ticket storage changed before this command completed.');
      }
      return operation();
    });
  }

  #read(source: AgentCommandSource, command: GarconTicketReadCommand): GarconTicketResult {
    const success = (data: unknown) => parseTicketCommandResult({ ...identity(source, command), status: 'ok', data });
    const budget: TicketReadBudget = { maxBytes: TICKET_LIMITS.markupBytes,
      measure: (data) => ticketBytes(garconTicketResultContent(success(data))) };
    const service = this.options.tickets.service;
    const payload = command.payload;
    switch (payload.action) {
      case 'list': return success(service.list(payload.query, budget));
      case 'read': return success(service.read(payload.query, { kind: 'chat', chatId: source.chatId }, budget));
      case 'history': return success(service.history(payload.query, budget));
    }
  }

  async #mutate(source: AgentCommandSource, command: GarconTicketMutationCommand,
    signal: AbortSignal, storeId: string): Promise<GarconTicketResult> {
    const payload = validateTicketInput(() => parseMarkupTicketMutationPayload(command.payload));
    const context = markupTicketContext(storeId, { chatId: source.chatId, transcriptViewId: source.viewId,
      ordinal: source.requestOrdinal }, command.ref, payload);
    const prepared = await this.#locked(source, signal, storeId, () => {
      const service = this.options.tickets.service;
      const previous = service.lookupOperation(context);
      if (previous) return { kind: 'complete' as const, result: this.#mutationResult(source, command, previous) };
      if (payload.action === 'create' && payload.input.project === undefined) {
        return { kind: 'resolve-project' as const, directory: this.options.registry.getChat(source.chatId)!.projectPath };
      }
      return { kind: 'complete' as const, result: this.#execute(source, command, context) };
    });
    if (prepared.kind === 'complete') return prepared.result;
    const probe = await (this.options.resolveProject ?? resolveTicketProjectDefault)(prepared.directory, signal).then(
      (value) => ({ value }), (error: unknown) => ({ error }),
    );
    return this.#locked(source, signal, storeId, () => {
      const previous = this.options.tickets.service.lookupOperation(context);
      if (previous) return this.#mutationResult(source, command, previous);
      if (this.options.registry.getChat(source.chatId)!.projectPath !== prepared.directory) throw sourceUnavailable();
      if ('error' in probe) throw probe.error;
      return this.#execute(source, command, context, probe.value.project);
    });
  }

  #execute(source: AgentCommandSource, command: GarconTicketMutationCommand,
    context: TicketMutationContext, project?: string): GarconTicketResult {
    const payload = command.payload;
    const resolved = payload.action === 'create'
      ? { ...payload, input: { ...payload.input, project: payload.input.project ?? project! } } : payload;
    return this.#mutationResult(source, command, this.options.tickets.service.execute(resolved, context));
  }

  #mutationResult(source: AgentCommandSource, command: GarconTicketMutationCommand,
    result: Parameters<typeof ticketMutationReceipt>[0]): GarconTicketResult {
    return parseTicketCommandResult({ ...identity(source, command), ticketId: result.ticket.id,
      status: 'ok', data: ticketMutationReceipt(result) });
  }

  async #reply(source: AgentCommandSource, result: GarconTicketResult, signal: AbortSignal): Promise<void> {
    const content = garconTicketResultContent(result);
    const deliver = await this.options.chatMutationLock.runExclusive(`chat:${source.chatId}`, async () => {
      if (!this.#replies.current(source, signal)) return false;
      const detail = ticketCommandOutcome(result);
      try {
        this.options.notices.appendNotice(source.chatId, source.viewId, {
          content: ticketCommandNoticeText(detail), detail,
          at: new Date().toISOString(),
        });
      } catch (error) { this.#replies.report(source, 'ticket-outcome', error); }
      return true;
    });
    if (!deliver || signal.aborted) return;
    try {
      await this.options.execution.deliverServerControlInput(source.chatId, {
        content, transcriptViewId: source.viewId, createdAt: new Date().toISOString(), receipt: null,
      }, signal);
    } catch (error) {
      if (!signal.aborted) this.#replies.report(source, 'ticket-result-delivery', error);
    }
  }
}

function identity(source: AgentCommandSource, command: GarconTicketCommand) {
  const payload = command.payload;
  const ticketId = payload.action === 'list' || payload.action === 'create' ? undefined
    : 'query' in payload ? payload.query.ticketId : payload.ticketId;
  const context = ticketCommandContext(command);
  return { command: payload.action, ...(command.ref === undefined ? {} : { ref: command.ref }),
    ...(context === undefined ? {} : { context }),
    ...(ticketId === undefined ? {} : { ticketId }), requestViewId: source.viewId, requestOrdinal: source.requestOrdinal };
}

function sourceUnavailable(): TicketDomainError {
  return new TicketDomainError('TICKET_SOURCE_UNAVAILABLE', 'The source chat, transcript view, or captured project context is no longer available.');
}
