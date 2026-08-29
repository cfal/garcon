import { parseChatId, type ChatId } from '../../common/chat-id.js';
import {
  garconMessageContent,
  INTER_AGENT_MESSAGE_NOTICE_TITLE,
} from '../../common/garcon-commands.js';
import type {
  InterAgentMessageFailureReason,
  InterAgentMessageReceivedNoticeDetail,
  InterAgentMessageResult,
} from '../../common/transcript-notice-details.js';
import type { ServerControlDisposition, ServerControlInput } from '../chat-execution/types.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { DomainError } from '../lib/domain-error.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import type { TranscriptViewId } from '../ledger/contracts.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { IChatRegistry } from './store.js';

export interface InterAgentMessageRequest {
  readonly sourceChatId: string;
  readonly sourceViewId: TranscriptViewId;
  readonly requestAt: string;
  readonly recipients: readonly ChatId[];
  readonly hideSender: boolean;
  readonly body: string;
}

interface InterAgentMessageAttempt {
  readonly abortController: AbortController;
}

export interface InterAgentMessageExecution {
  deliverInterAgentControlInput(
    chatId: string,
    input: ServerControlInput,
    signal: AbortSignal,
  ): Promise<ServerControlDisposition>;
}

export interface InterAgentMessageDispositionEvent {
  readonly sourceChatId: string;
  readonly targetChatId: string;
  readonly status: InterAgentMessageResult['status'];
  readonly reason?: InterAgentMessageFailureReason;
}

export interface InterAgentMessageErrorContext {
  readonly sourceChatId: string;
  readonly targetChatId?: string;
  readonly phase:
    | 'source-validation'
    | 'target-adoption'
    | 'target-delivery'
    | 'target-receipt'
    | 'source-outcome';
}

export interface InterAgentMessageControllerOptions {
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly adoption: Pick<TranscriptAdoptionService, 'ensure'>;
  readonly execution: InterAgentMessageExecution;
  readonly notices: Pick<TranscriptLedgerService, 'appendNotice'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly isEnabled: () => boolean;
  readonly onDisposition?: (event: InterAgentMessageDispositionEvent) => void;
  readonly onError?: (error: unknown, context: InterAgentMessageErrorContext) => void;
}

export class InterAgentMessageController {
  readonly #attempts = new Map<string, Set<InterAgentMessageAttempt>>();

  constructor(private readonly options: InterAgentMessageControllerOptions) {}

  request(input: InterAgentMessageRequest): void {
    const attempt = this.#registerAttempt(input.sourceChatId);
    void this.#deliver(input, attempt).finally(() => {
      this.#retireAttempt(input.sourceChatId, attempt);
    });
  }

  discardSource(chatId: string): void {
    const attempts = this.#attempts.get(chatId);
    if (!attempts) return;
    for (const attempt of attempts) attempt.abortController.abort();
    this.#attempts.delete(chatId);
  }

  async #deliver(
    input: InterAgentMessageRequest,
    attempt: InterAgentMessageAttempt,
  ): Promise<void> {
    const signal = attempt.abortController.signal;
    if (!this.options.isEnabled()) {
      this.#recordOutcome(
        input,
        attempt,
        input.recipients.map((chatId) => ({
          chatId,
          status: 'failed',
          reason: 'disabled',
        })),
      );
      return;
    }
    let sourceChatId: ChatId;
    try {
      sourceChatId = parseChatId(input.sourceChatId);
    } catch (error) {
      this.#reportError(error, {
        sourceChatId: input.sourceChatId,
        phase: 'source-validation',
      });
      const results = input.recipients.map((chatId): InterAgentMessageResult => ({
        chatId,
        status: 'failed',
        reason: 'delivery-failed',
      }));
      this.#recordOutcome(input, attempt, results);
      return;
    }

    try {
      const settled = await Promise.allSettled(input.recipients.map((targetChatId) => (
        this.#deliverToTarget(input, sourceChatId, targetChatId, signal)
      )));
      signal.throwIfAborted();
      const results = settled.map((result, index): InterAgentMessageResult => {
        if (result.status === 'fulfilled') return result.value;
        const targetChatId = input.recipients[index]!;
        this.#reportError(result.reason, {
          sourceChatId: input.sourceChatId,
          targetChatId,
          phase: 'target-delivery',
        });
        return this.#result(input.sourceChatId, targetChatId, 'delivery-failed');
      });
      this.#recordOutcome(input, attempt, results);
    } catch (error) {
      if (signal.aborted) return;
      this.#reportError(error, {
        sourceChatId: input.sourceChatId,
        phase: 'source-outcome',
      });
    }
  }

  async #deliverToTarget(
    input: InterAgentMessageRequest,
    sourceChatId: ChatId,
    targetChatId: ChatId,
    signal: AbortSignal,
  ): Promise<InterAgentMessageResult> {
    if (targetChatId === sourceChatId) {
      return this.#result(input.sourceChatId, targetChatId, 'self-send');
    }

    return this.options.chatMutationLock.runExclusive(`chat:${targetChatId}`, async () => {
      signal.throwIfAborted();
      if (!this.options.registry.getChat(targetChatId)) {
        return this.#result(input.sourceChatId, targetChatId, 'target-not-found');
      }

      let view: Awaited<ReturnType<TranscriptAdoptionService['ensure']>>;
      try {
        view = await this.options.adoption.ensure(targetChatId, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!this.options.registry.getChat(targetChatId)) {
          return this.#result(input.sourceChatId, targetChatId, 'target-not-found');
        }
        this.#reportError(error, {
          sourceChatId: input.sourceChatId,
          targetChatId,
          phase: 'target-adoption',
        });
        return this.#result(input.sourceChatId, targetChatId, 'target-unavailable');
      }

      signal.throwIfAborted();
      if (!this.options.registry.getChat(targetChatId)) {
        return this.#result(input.sourceChatId, targetChatId, 'target-not-found');
      }

      const fromChatId = input.hideSender ? null : sourceChatId;
      const receipt = receivedMessageNotice(fromChatId, input.body);
      const controlInput: ServerControlInput = {
        content: garconMessageContent(fromChatId, input.body),
        transcriptViewId: view.viewId,
        createdAt: input.requestAt,
        receipt,
      };

      let disposition: ServerControlDisposition;
      try {
        disposition = await this.options.execution.deliverInterAgentControlInput(
          targetChatId,
          controlInput,
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        return this.#result(
          input.sourceChatId,
          targetChatId,
          classifyDeliveryFailure(error),
        );
      }

      signal.throwIfAborted();
      if (disposition === 'delivered') {
        try {
          this.options.notices.appendNotice(targetChatId, view.viewId, {
            ...receipt,
            at: input.requestAt,
          });
        } catch (error) {
          this.#reportError(error, {
            sourceChatId: input.sourceChatId,
            targetChatId,
            phase: 'target-receipt',
          });
        }
      }
      return this.#result(input.sourceChatId, targetChatId, disposition);
    });
  }

  #result(
    sourceChatId: string,
    targetChatId: ChatId,
    disposition: ServerControlDisposition | InterAgentMessageFailureReason,
  ): InterAgentMessageResult {
    const result: InterAgentMessageResult = disposition === 'delivered' || disposition === 'queued'
      ? { chatId: targetChatId, status: disposition }
      : { chatId: targetChatId, status: 'failed', reason: disposition };
    try {
      this.options.onDisposition?.('reason' in result
        ? {
            sourceChatId,
            targetChatId,
            status: result.status,
            reason: result.reason,
          }
        : { sourceChatId, targetChatId, status: result.status });
    } catch {
      // Observability must not change message delivery.
    }
    return result;
  }

  #recordOutcome(
    input: InterAgentMessageRequest,
    attempt: InterAgentMessageAttempt,
    results: readonly InterAgentMessageResult[],
  ): void {
    if (!this.#attempts.get(input.sourceChatId)?.has(attempt)) return;
    if (attempt.abortController.signal.aborted) return;
    try {
      this.options.notices.appendNotice(input.sourceChatId, input.sourceViewId, {
        title: INTER_AGENT_MESSAGE_NOTICE_TITLE,
        content: renderOutcome(input.body, results),
        detail: { type: 'inter-agent-message-outcome', results },
        at: input.requestAt,
      });
    } catch (error) {
      this.#reportError(error, {
        sourceChatId: input.sourceChatId,
        phase: 'source-outcome',
      });
    }
  }

  #registerAttempt(sourceChatId: string): InterAgentMessageAttempt {
    const attempt = { abortController: new AbortController() };
    const attempts = this.#attempts.get(sourceChatId) ?? new Set();
    attempts.add(attempt);
    this.#attempts.set(sourceChatId, attempts);
    return attempt;
  }

  #retireAttempt(sourceChatId: string, attempt: InterAgentMessageAttempt): void {
    const attempts = this.#attempts.get(sourceChatId);
    if (!attempts) return;
    attempts.delete(attempt);
    if (attempts.size === 0) this.#attempts.delete(sourceChatId);
  }

  #reportError(error: unknown, context: InterAgentMessageErrorContext): void {
    try {
      this.options.onError?.(error, context);
    } catch {
      // Diagnostics must not change message delivery.
    }
  }
}

function receivedMessageNotice(
  fromChatId: ChatId | null,
  body: string,
): ServerControlInput['receipt'] {
  const detail: InterAgentMessageReceivedNoticeDetail = {
    type: 'inter-agent-message-received',
    fromChatId,
  };
  return {
    title: fromChatId === null
      ? INTER_AGENT_MESSAGE_NOTICE_TITLE
      : `Message from chat ${fromChatId}`,
    content: body,
    detail,
  };
}

function classifyDeliveryFailure(error: unknown): InterAgentMessageFailureReason {
  if (!(error instanceof DomainError)) return 'delivery-failed';
  switch (error.code) {
    case 'SESSION_NOT_FOUND':
    case 'CHAT_DELETED':
      return 'target-not-found';
    case 'CONTROL_INPUT_QUEUE_FULL':
      return 'queue-full';
    case 'STEER_PROVIDER_REJECTED':
      return 'provider-rejected';
    case 'STEER_OUTCOME_UNKNOWN':
      return 'delivery-unknown';
    case 'SERVER_SHUTTING_DOWN':
      return 'server-shutting-down';
    case 'SESSION_BUSY':
    case 'STALE_TRANSCRIPT_VIEW':
    case 'TRANSCRIPT_UNAVAILABLE':
    case 'TRANSCRIPT_DEFERRED':
    case 'OWNERSHIP_TRANSFER_PENDING':
      return 'target-unavailable';
    default:
      return 'delivery-failed';
  }
}

function renderOutcome(body: string, results: readonly InterAgentMessageResult[]): string {
  const lines = results.map((result) => {
    switch (result.status) {
      case 'delivered':
        return `Delivered: ${result.chatId}`;
      case 'queued':
        return `Queued: ${result.chatId} (pending delivery is not retained across server restart)`;
      case 'failed':
        return `Failed: ${result.chatId} (${failureReasonContent(result.reason)})`;
    }
  });
  return `${lines.join('\n')}\n\n${body}`;
}

function failureReasonContent(reason: InterAgentMessageFailureReason): string {
  switch (reason) {
    case 'disabled':
      return 'agent messaging is disabled';
    case 'self-send':
      return 'cannot send to the source chat';
    case 'target-not-found':
      return 'chat not found';
    case 'target-unavailable':
      return 'chat unavailable';
    case 'queue-full':
      return 'control input queue full';
    case 'provider-rejected':
      return 'target agent rejected the message';
    case 'delivery-unknown':
      return 'delivery may have occurred; no retry was queued';
    case 'server-shutting-down':
      return 'server shutting down';
    case 'delivery-failed':
      return 'delivery failed';
  }
}
