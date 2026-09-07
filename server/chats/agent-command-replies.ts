import {
  agentCommandOutcomeContent,
  garconCommandResultContent,
  type AgentCommandOutcomeNoticeDetail,
} from '../../common/garcon-command-results.js';
import type { ChatExecutionCoordinator } from '../chat-execution/chat-execution-coordinator.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import { diagnosticErrorCode } from '../lib/errors.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import type { IChatRegistry } from './store.js';

const logger = createLogger('agent-commands');

export interface AgentCommandContext {
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly notices: Pick<TranscriptLedgerService, 'existingCurrentView' | 'appendNotice'>;
  readonly execution: Pick<ChatExecutionCoordinator, 'deliverServerControlInput'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly isEnabled: () => boolean;
}

export class AgentCommandReplies {
  readonly #attempts = new Map<string, Set<AbortController>>();
  #stopped = false;

  constructor(private readonly context: AgentCommandContext) {}

  launch(
    source: AgentCommandSource,
    operation: (signal: AbortSignal) => Promise<AgentCommandOutcomeNoticeDetail | null>,
  ): void {
    if (this.#stopped) return;
    const abort = new AbortController();
    const attempts = this.#attempts.get(source.chatId) ?? new Set<AbortController>();
    attempts.add(abort);
    this.#attempts.set(source.chatId, attempts);
    void (async () => {
      const detail = await operation(abort.signal);
      if (!detail || abort.signal.aborted) return;
      const disposition = await this.context.execution.deliverServerControlInput(source.chatId, {
        content: garconCommandResultContent(detail),
        transcriptViewId: source.viewId,
        createdAt: new Date().toISOString(),
        receipt: null,
      }, abort.signal);
      logger.debug('Agent command result disposition', {
        chatId: source.chatId, viewId: source.viewId, requestOrdinal: source.requestOrdinal, disposition,
      });
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) this.report(source, 'result-delivery', error);
    }).finally(() => {
      attempts.delete(abort);
      if (this.#attempts.get(source.chatId) === attempts && attempts.size === 0) {
        this.#attempts.delete(source.chatId);
      }
    });
  }

  current(source: AgentCommandSource, signal: AbortSignal): boolean {
    return !signal.aborted && this.context.registry.getChat(source.chatId) !== null
      && this.context.notices.existingCurrentView(source.chatId)?.viewId === source.viewId;
  }

  record(source: AgentCommandSource, detail: AgentCommandOutcomeNoticeDetail): AgentCommandOutcomeNoticeDetail | null {
    try {
      this.context.notices.appendNotice(source.chatId, source.viewId, {
        title: detail.type === 'agent-start-outcome' ? 'Start agent' : 'Schedule prompt',
        content: agentCommandOutcomeContent(detail),
        detail,
        at: new Date().toISOString(),
      });
      return detail;
    } catch (error) {
      this.report(source, 'outcome', error, detail);
      return null;
    }
  }

  report(source: AgentCommandSource, phase: string, error: unknown, detail?: AgentCommandOutcomeNoticeDetail): void {
    logger.warn('Agent command operation failed', {
      chatId: source.chatId, viewId: source.viewId, requestOrdinal: source.requestOrdinal,
      phase, errorCode: diagnosticErrorCode(error),
      ...detail && 'chatId' in detail ? { childChatId: detail.chatId } : {},
      ...detail && 'scheduleId' in detail ? { scheduleId: detail.scheduleId } : {},
    });
  }

  discardSource(chatId: string): void {
    for (const abort of this.#attempts.get(chatId) ?? []) abort.abort();
    this.#attempts.delete(chatId);
  }

  shutdown(): void {
    this.#stopped = true;
    for (const chatId of this.#attempts.keys()) this.discardSource(chatId);
  }
}
