import crypto from 'node:crypto';
import type { ChatId } from '../../common/chat-id.js';
import {
  garconCreateChatResultsContent,
  SUB_AGENT_START_NOTICE_TITLE,
  type GarconCreateChatFailureMessage,
  type GarconCreateChatParams,
  type GarconCreateChatResult,
} from '../../common/garcon-start-agent.js';
import type { RemoteExecutionDefaults } from '../../common/settings.js';
import {
  renderSubAgentStartOutcome,
  type SubAgentResultDeliveryStatus,
  type SubAgentStartOutcomeNoticeDetail,
} from '../../common/transcript-notice-details.js';
import type { AgentStartSelectionService } from '../agents/agent-start-selection-service.js';
import type { ServerControlDisposition, ServerControlInput } from '../chat-execution/types.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { TranscriptView, TranscriptViewId } from '../ledger/contracts.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import type { ChatIdAllocator } from './chat-id-allocator.js';
import type { IChatRegistry } from './store.js';

const CHAT_ID_ALLOCATION_ATTEMPTS = 3;

export interface AgentStartRequest {
  readonly sourceChatId: string;
  readonly sourceViewId: TranscriptViewId;
  readonly requestRunId: string | null;
  readonly requestAt: string;
  readonly prompt: string;
  readonly params: readonly GarconCreateChatParams[];
}

interface AgentStartAttempt {
  readonly abortController: AbortController;
  readonly projectPath: string;
  readonly executionDefaults: RemoteExecutionDefaults;
}

export interface AgentStartErrorContext {
  readonly sourceChatId: string;
  readonly ref?: string;
  readonly phase: 'admission' | 'selection' | 'start' | 'result-delivery';
}

export interface AgentStartDispositionEvent {
  readonly sourceChatId: string;
  readonly deliveryStatus: SubAgentResultDeliveryStatus;
  readonly resultCount: number;
}

export interface AgentStartControllerOptions {
  readonly registry: Pick<IChatRegistry, 'getChat'>;
  readonly selection: Pick<AgentStartSelectionService, 'resolve'>;
  readonly commands: Pick<ChatCommandService, 'submitAgentCommandStart'>;
  readonly chatIds: Pick<ChatIdAllocator, 'allocate'>;
  readonly execution: {
    deliverAgentCommandResult(
      chatId: string,
      input: ServerControlInput,
      requestRunId: string | null,
      signal: AbortSignal,
    ): Promise<ServerControlDisposition>;
  };
  readonly notices: Pick<TranscriptLedgerService, 'appendNotice' | 'currentView'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly batchLock?: KeyedPromiseLock;
  readonly getExecutionDefaults: () => RemoteExecutionDefaults;
  readonly isEnabled: () => boolean;
  readonly createId?: () => string;
  readonly onDisposition?: (event: AgentStartDispositionEvent) => void;
  readonly onError?: (error: unknown, context: AgentStartErrorContext) => void;
}

export class AgentStartController {
  readonly #attempts = new Map<string, Set<AgentStartAttempt>>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #createId: () => string;
  readonly #batchLock: KeyedPromiseLock;
  #shuttingDown = false;

  constructor(private readonly options: AgentStartControllerOptions) {
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#batchLock = options.batchLock ?? new KeyedPromiseLock();
  }

  request(input: AgentStartRequest): void {
    if (this.#shuttingDown) return;
    const source = this.options.registry.getChat(input.sourceChatId);
    if (!source) {
      this.#reportError(new Error('Source chat not found'), {
        sourceChatId: input.sourceChatId,
        phase: 'admission',
      });
      return;
    }

    let executionDefaults: RemoteExecutionDefaults;
    try {
      executionDefaults = structuredClone(this.options.getExecutionDefaults());
    } catch (error) {
      this.#reportError(error, { sourceChatId: input.sourceChatId, phase: 'admission' });
      return;
    }

    const attempt: AgentStartAttempt = {
      abortController: new AbortController(),
      projectPath: source.projectPath,
      executionDefaults,
    };
    this.#registerAttempt(input.sourceChatId, attempt);
    const task = this.#batchLock
      .runExclusive(`agent-start:${input.sourceChatId}`, () => this.#run(input, attempt))
      .catch((error) => {
        if (!attempt.abortController.signal.aborted) {
          this.#reportError(error, {
            sourceChatId: input.sourceChatId,
            phase: 'result-delivery',
          });
        }
      })
      .finally(() => {
        this.#tasks.delete(task);
        this.#retireAttempt(input.sourceChatId, attempt);
      });
    this.#tasks.add(task);
  }

  discardSource(chatId: string): void {
    for (const attempt of this.#attempts.get(chatId) ?? []) {
      attempt.abortController.abort();
    }
    this.#attempts.delete(chatId);
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
  }

  async waitForIdle(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  async #run(input: AgentStartRequest, attempt: AgentStartAttempt): Promise<void> {
    const signal = attempt.abortController.signal;
    signal.throwIfAborted();

    if (!this.options.isEnabled()) {
      const results = input.params.map((params) => failureResult(params.ref, 'disabled'));
      await this.#appendOutcome(input, results, 'disabled', signal);
      return;
    }

    const results: GarconCreateChatResult[] = [];
    for (let index = 0; index < input.params.length; index += 1) {
      signal.throwIfAborted();
      const params = input.params[index]!;
      if (this.#shuttingDown) {
        appendRemainingFailures(results, input.params, index, 'server-shutting-down');
        break;
      }
      if (!this.options.isEnabled()) {
        appendRemainingFailures(results, input.params, index, 'disabled');
        break;
      }
      results.push(await this.#startOne(input, params, attempt));
    }

    signal.throwIfAborted();
    await this.#deliverResults(input, results, signal);
  }

  async #startOne(
    input: AgentStartRequest,
    params: GarconCreateChatParams,
    attempt: AgentStartAttempt,
  ): Promise<GarconCreateChatResult> {
    let resolved: Awaited<ReturnType<AgentStartSelectionService['resolve']>>;
    try {
      resolved = await this.options.selection.resolve(params, attempt.executionDefaults);
    } catch (error) {
      this.#reportError(error, {
        sourceChatId: input.sourceChatId,
        ref: params.ref,
        phase: 'selection',
      });
      return failureResult(params.ref, 'start-failed');
    }
    if (!resolved.ok) return failureResult(params.ref, resolved.message);

    for (let allocationAttempt = 0; allocationAttempt < CHAT_ID_ALLOCATION_ATTEMPTS; allocationAttempt += 1) {
      attempt.abortController.signal.throwIfAborted();
      if (this.#shuttingDown) return failureResult(params.ref, 'server-shutting-down');

      let chatId: ChatId;
      try {
        chatId = this.options.chatIds.allocate();
      } catch (error) {
        this.#reportError(error, {
          sourceChatId: input.sourceChatId,
          ref: params.ref,
          phase: 'start',
        });
        return failureResult(params.ref, 'start-failed');
      }

      try {
        await this.options.commands.submitAgentCommandStart({
          chatId,
          clientRequestId: this.#createId(),
          clientMessageId: this.#createId(),
          agentId: params.agentId,
          projectPath: attempt.projectPath,
          command: input.prompt,
          model: resolved.selection.model,
          apiProviderId: resolved.selection.apiProviderId,
          modelEndpointId: resolved.selection.modelEndpointId,
          modelProtocol: resolved.selection.modelProtocol,
          permissionMode: resolved.selection.permissionMode,
          thinkingMode: resolved.selection.thinkingMode,
          agentSettings: resolved.selection.agentSettings,
          tags: ['sub-agent'],
        });
        return {
          ref: params.ref,
          error: false,
          msg: 'created',
          chatId,
        };
      } catch (error) {
        const code = structuredErrorCode(error);
        if (code === 'CHAT_ID_COLLISION') continue;
        if (code === 'SESSION_LIMIT') return failureResult(params.ref, 'session-limit');
        if (code === 'SERVER_SHUTTING_DOWN') {
          return failureResult(params.ref, 'server-shutting-down');
        }
        this.#reportError(error, {
          sourceChatId: input.sourceChatId,
          ref: params.ref,
          phase: 'start',
        });
        return failureResult(params.ref, 'start-failed');
      }
    }
    return failureResult(params.ref, 'chat-id-collision');
  }

  async #deliverResults(
    input: AgentStartRequest,
    results: readonly GarconCreateChatResult[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.options.chatMutationLock.runExclusive(`chat:${input.sourceChatId}`, async () => {
      signal.throwIfAborted();
      if (!this.#sourceViewIsCurrent(input)) return;

      const deliveredDetail = outcomeDetail('delivered', results);
      const controlInput: ServerControlInput = {
        content: garconCreateChatResultsContent(results),
        transcriptViewId: input.sourceViewId,
        createdAt: input.requestAt,
        receipt: {
          title: SUB_AGENT_START_NOTICE_TITLE,
          content: renderSubAgentStartOutcome('delivered', results),
          detail: deliveredDetail,
        },
      };

      let deliveryStatus: SubAgentResultDeliveryStatus;
      try {
        deliveryStatus = await this.options.execution.deliverAgentCommandResult(
          input.sourceChatId,
          controlInput,
          input.requestRunId,
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        deliveryStatus = structuredErrorCode(error) === 'STEER_OUTCOME_UNKNOWN'
          ? 'delivery-unknown'
          : 'delivery-failed';
        this.#reportError(error, {
          sourceChatId: input.sourceChatId,
          phase: 'result-delivery',
        });
      }
      this.#appendOutcomeNow(input, results, deliveryStatus);
    });
  }

  async #appendOutcome(
    input: AgentStartRequest,
    results: readonly GarconCreateChatResult[],
    deliveryStatus: SubAgentResultDeliveryStatus,
    signal: AbortSignal,
  ): Promise<void> {
    await this.options.chatMutationLock.runExclusive(`chat:${input.sourceChatId}`, async () => {
      signal.throwIfAborted();
      if (!this.#sourceViewIsCurrent(input)) return;
      this.#appendOutcomeNow(input, results, deliveryStatus);
    });
  }

  #appendOutcomeNow(
    input: AgentStartRequest,
    results: readonly GarconCreateChatResult[],
    deliveryStatus: SubAgentResultDeliveryStatus,
  ): void {
    this.options.notices.appendNotice(input.sourceChatId, input.sourceViewId, {
      title: SUB_AGENT_START_NOTICE_TITLE,
      content: renderSubAgentStartOutcome(deliveryStatus, results),
      detail: outcomeDetail(deliveryStatus, results),
      at: input.requestAt,
    });
    try {
      this.options.onDisposition?.({
        sourceChatId: input.sourceChatId,
        deliveryStatus,
        resultCount: results.length,
      });
    } catch {
      // Observability must not change command execution.
    }
  }

  #sourceViewIsCurrent(input: AgentStartRequest): boolean {
    if (!this.options.registry.getChat(input.sourceChatId)) return false;
    return sameView(this.options.notices.currentView(input.sourceChatId), input.sourceViewId);
  }

  #registerAttempt(sourceChatId: string, attempt: AgentStartAttempt): void {
    const attempts = this.#attempts.get(sourceChatId) ?? new Set();
    attempts.add(attempt);
    this.#attempts.set(sourceChatId, attempts);
  }

  #retireAttempt(sourceChatId: string, attempt: AgentStartAttempt): void {
    const attempts = this.#attempts.get(sourceChatId);
    if (!attempts) return;
    attempts.delete(attempt);
    if (attempts.size === 0) this.#attempts.delete(sourceChatId);
  }

  #reportError(error: unknown, context: AgentStartErrorContext): void {
    try {
      this.options.onError?.(error, context);
    } catch {
      // Diagnostics must not change command execution.
    }
  }
}

function failureResult(
  ref: string,
  message: GarconCreateChatFailureMessage,
): GarconCreateChatResult {
  return { ref, error: true, msg: message };
}

function appendRemainingFailures(
  results: GarconCreateChatResult[],
  params: readonly GarconCreateChatParams[],
  startIndex: number,
  message: GarconCreateChatFailureMessage,
): void {
  for (let index = startIndex; index < params.length; index += 1) {
    results.push(failureResult(params[index]!.ref, message));
  }
}

function outcomeDetail(
  deliveryStatus: SubAgentResultDeliveryStatus,
  results: readonly GarconCreateChatResult[],
): SubAgentStartOutcomeNoticeDetail {
  return {
    type: 'sub-agent-start-outcome',
    deliveryStatus,
    results: results.map((result) => ({ ...result })),
  };
}

function sameView(view: TranscriptView | null, expected: TranscriptViewId): boolean {
  return view?.viewId === expected;
}

function structuredErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
