import crypto from 'node:crypto';
import type { ChatId } from '../../common/chat-id.js';
import type { PermissionMode } from '../../common/chat-modes.js';
import {
  garconCreateChatResultsContent,
  SUB_AGENT_START_NOTICE_TITLE,
  type GarconCreateChatFailureMessage,
  type GarconCreateChatParams,
  type GarconCreateChatResult,
  type GarconCreateChatResultMessage,
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
import { structuredErrorCode } from '../lib/errors.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { TranscriptViewId } from '../ledger/contracts.js';
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
  readonly permissionMode: PermissionMode;
  readonly executionDefaults: RemoteExecutionDefaults;
  readonly sourceViewId: TranscriptViewId;
  readonly requestRunId: string | null;
  readonly itemCount: number;
  completedCount: number;
}

export interface SubAgentOverridePolicy {
  readonly projectPath: boolean;
  readonly permissionLevel: boolean;
}

export interface AgentStartErrorContext {
  readonly sourceChatId: string;
  readonly sourceViewId: TranscriptViewId;
  readonly requestRunId: string | null;
  readonly ref?: string;
  readonly targetChatId?: ChatId;
  readonly itemIndex?: number;
  readonly itemCount?: number;
  readonly attempt?: number;
  readonly phase: 'admission' | 'selection' | 'start' | 'result-delivery';
}

export interface AgentStartDiagnosticEvent {
  readonly event:
    | 'batch-admission'
    | 'selection'
    | 'collision-retry'
    | 'start'
    | 'source-abort'
    | 'batch-stop'
    | 'result-delivery';
  readonly sourceChatId: string;
  readonly sourceViewId: TranscriptViewId;
  readonly requestRunId: string | null;
  readonly status:
    | 'admitted'
    | 'source-not-found'
    | 'settings-unavailable'
    | 'resolved'
    | 'retrying'
    | 'aborted'
    | 'server-shutting-down'
    | GarconCreateChatResultMessage
    | SubAgentResultDeliveryStatus;
  readonly itemCount: number;
  readonly ref?: string;
  readonly targetChatId?: ChatId | null;
  readonly itemIndex?: number;
  readonly completedCount?: number;
  readonly attempt?: number;
  readonly elapsedMs?: number;
}

interface AgentStartDiagnosticContext {
  readonly sourceChatId: string;
  readonly sourceViewId: TranscriptViewId;
  readonly requestRunId: string | null;
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
      onQueued: () => void,
    ): Promise<ServerControlDisposition>;
  };
  readonly notices: Pick<TranscriptLedgerService, 'appendNotice' | 'currentView'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly batchLock?: KeyedPromiseLock;
  readonly getExecutionDefaults: () => RemoteExecutionDefaults;
  readonly getOverridePolicy: () => SubAgentOverridePolicy;
  readonly isEnabled: () => boolean;
  readonly createId?: () => string;
  readonly onDiagnostic?: (event: AgentStartDiagnosticEvent) => void;
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
    if (this.#shuttingDown) {
      this.#emitDiagnostic({
        ...diagnosticContext(input),
        event: 'batch-admission',
        status: 'server-shutting-down',
        itemCount: input.params.length,
      });
      return;
    }
    const source = this.options.registry.getChat(input.sourceChatId);
    if (!source) {
      this.#emitDiagnostic({
        ...diagnosticContext(input),
        event: 'batch-admission',
        status: 'source-not-found',
        itemCount: input.params.length,
      });
      this.#reportError(new Error('Source chat not found'), errorContext(input, 'admission'));
      return;
    }

    let executionDefaults: RemoteExecutionDefaults;
    try {
      executionDefaults = structuredClone(this.options.getExecutionDefaults());
    } catch (error) {
      this.#emitDiagnostic({
        ...diagnosticContext(input),
        event: 'batch-admission',
        status: 'settings-unavailable',
        itemCount: input.params.length,
      });
      this.#reportError(error, errorContext(input, 'admission'));
      return;
    }

    const attempt: AgentStartAttempt = {
      abortController: new AbortController(),
      projectPath: source.projectPath,
      permissionMode: source.permissionMode,
      executionDefaults,
      sourceViewId: input.sourceViewId,
      requestRunId: input.requestRunId,
      itemCount: input.params.length,
      completedCount: 0,
    };
    this.#registerAttempt(input.sourceChatId, attempt);
    this.#emitDiagnostic({
      ...diagnosticContext(input),
      event: 'batch-admission',
      status: 'admitted',
      itemCount: input.params.length,
    });
    const task = this.#batchLock
      .runExclusive(`agent-start:${input.sourceChatId}`, () => this.#run(input, attempt))
      .catch((error) => {
        if (!attempt.abortController.signal.aborted) {
          this.#reportError(error, errorContext(input, 'result-delivery'));
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
      this.#emitDiagnostic({
        sourceChatId: chatId,
        sourceViewId: attempt.sourceViewId,
        requestRunId: attempt.requestRunId,
        event: 'source-abort',
        status: 'aborted',
        completedCount: attempt.completedCount,
        itemCount: attempt.itemCount,
      });
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
      this.#emitDiagnostic({
        ...diagnosticContext(input),
        event: 'batch-stop',
        status: 'disabled',
        itemIndex: 1,
        itemCount: input.params.length,
      });
      const results = input.params.map((params) => failureResult(params.ref, 'disabled'));
      await this.#withCurrentSourceView(input, signal, () => {
        this.#appendOutcome(input, results, 'disabled');
      });
      return;
    }

    const results: GarconCreateChatResult[] = [];
    for (let index = 0; index < input.params.length; index += 1) {
      signal.throwIfAborted();
      const params = input.params[index]!;
      if (this.#shuttingDown) {
        this.#emitDiagnostic({
          ...diagnosticContext(input),
          event: 'batch-stop',
          status: 'server-shutting-down',
          itemIndex: index + 1,
          itemCount: input.params.length,
        });
        appendRemainingFailures(results, input.params, index, 'server-shutting-down');
        attempt.completedCount = results.length;
        break;
      }
      if (!this.options.isEnabled()) {
        this.#emitDiagnostic({
          ...diagnosticContext(input),
          event: 'batch-stop',
          status: 'disabled',
          itemIndex: index + 1,
          itemCount: input.params.length,
        });
        appendRemainingFailures(results, input.params, index, 'disabled');
        attempt.completedCount = results.length;
        break;
      }
      results.push(await this.#startOne(
        input,
        params,
        index + 1,
        attempt,
        this.options.getOverridePolicy(),
      ));
      attempt.completedCount = results.length;
    }

    signal.throwIfAborted();
    await this.#deliverResults(input, results, signal);
  }

  async #startOne(
    input: AgentStartRequest,
    params: GarconCreateChatParams,
    itemIndex: number,
    attempt: AgentStartAttempt,
    overridePolicy: SubAgentOverridePolicy,
  ): Promise<GarconCreateChatResult> {
    const startedAt = performance.now();
    let attemptCount = 0;
    let targetChatId: ChatId | null = null;
    const finish = (result: GarconCreateChatResult): GarconCreateChatResult => {
      this.#emitDiagnostic({
        ...diagnosticContext(input),
        event: 'start',
        status: result.msg,
        ref: params.ref,
        targetChatId,
        itemIndex,
        itemCount: input.params.length,
        attempt: attemptCount,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return result;
    };

    if (params.projectPath !== null && !overridePolicy.projectPath) {
      return finish(failureResult(params.ref, 'project-path-override-disabled'));
    }
    if (params.permissionMode !== null && !overridePolicy.permissionLevel) {
      return finish(failureResult(params.ref, 'permission-override-disabled'));
    }
    const effectiveProjectPath = params.projectPath ?? attempt.projectPath;
    const effectivePermissionMode = params.permissionMode ?? attempt.permissionMode;

    let resolved: Awaited<ReturnType<AgentStartSelectionService['resolve']>>;
    try {
      resolved = await this.options.selection.resolve(
        params,
        attempt.executionDefaults,
        effectivePermissionMode,
      );
    } catch (error) {
      this.#emitDiagnostic({
        ...diagnosticContext(input),
        event: 'selection',
        status: 'start-failed',
        ref: params.ref,
        itemIndex,
        itemCount: input.params.length,
      });
      this.#reportError(error, {
        ...errorContext(input, 'selection'),
        ref: params.ref,
        itemIndex,
        itemCount: input.params.length,
      });
      return finish(failureResult(params.ref, 'start-failed'));
    }
    this.#emitDiagnostic({
      ...diagnosticContext(input),
      event: 'selection',
      status: resolved.ok ? 'resolved' : resolved.message,
      ref: params.ref,
      itemIndex,
      itemCount: input.params.length,
    });
    if (!resolved.ok) {
      if (resolved.message === 'start-failed') {
        this.#reportError({ code: 'INVALID_CATALOG' }, {
          ...errorContext(input, 'selection'),
          ref: params.ref,
          itemIndex,
          itemCount: input.params.length,
        });
      }
      return finish(failureResult(params.ref, resolved.message));
    }

    for (
      let allocationAttempt = 0;
      allocationAttempt < CHAT_ID_ALLOCATION_ATTEMPTS;
      allocationAttempt += 1
    ) {
      attempt.abortController.signal.throwIfAborted();
      if (this.#shuttingDown) return finish(failureResult(params.ref, 'server-shutting-down'));
      attemptCount = allocationAttempt + 1;

      try {
        targetChatId = this.options.chatIds.allocate();
      } catch (error) {
        this.#reportError(error, {
          ...errorContext(input, 'start'),
          ref: params.ref,
          itemIndex,
          itemCount: input.params.length,
          attempt: attemptCount,
        });
        return finish(failureResult(params.ref, 'start-failed'));
      }

      try {
        await this.options.commands.submitAgentCommandStart({
          chatId: targetChatId,
          clientRequestId: this.#createId(),
          clientMessageId: this.#createId(),
          agentId: params.agentId,
          projectPath: effectiveProjectPath,
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
        return finish({
          ref: params.ref,
          error: false,
          msg: 'created',
          chatId: targetChatId,
        });
      } catch (error) {
        const code = structuredErrorCode(error);
        if (code === 'CHAT_ID_COLLISION') {
          if (attemptCount < CHAT_ID_ALLOCATION_ATTEMPTS) {
            this.#emitDiagnostic({
              ...diagnosticContext(input),
              event: 'collision-retry',
              status: 'retrying',
              ref: params.ref,
              targetChatId,
              itemIndex,
              itemCount: input.params.length,
              attempt: attemptCount,
            });
          }
          continue;
        }
        if (code === 'SESSION_LIMIT') return finish(failureResult(params.ref, 'session-limit'));
        if (code === 'SERVER_SHUTTING_DOWN') {
          return finish(failureResult(params.ref, 'server-shutting-down'));
        }
        if (code === 'PROJECT_PATH_OUTSIDE_BASE' || code === 'PROJECT_PATH_NOT_FOUND') {
          return finish(failureResult(params.ref, 'unknown-project-path'));
        }
        this.#reportError(error, {
          ...errorContext(input, 'start'),
          ref: params.ref,
          targetChatId,
          itemIndex,
          itemCount: input.params.length,
          attempt: attemptCount,
        });
        return finish(failureResult(params.ref, 'start-failed'));
      }
    }
    return finish(failureResult(params.ref, 'chat-id-collision'));
  }

  async #deliverResults(
    input: AgentStartRequest,
    results: readonly GarconCreateChatResult[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.#withCurrentSourceView(input, signal, async () => {
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
          () => {
            this.#appendOutcome(input, results, 'queued');
          },
        );
      } catch (error) {
        signal.throwIfAborted();
        deliveryStatus = structuredErrorCode(error) === 'STEER_OUTCOME_UNKNOWN'
          ? 'delivery-unknown'
          : 'delivery-failed';
        this.#reportError(error, errorContext(input, 'result-delivery'));
      }
      if (deliveryStatus !== 'queued') {
        this.#appendOutcome(input, results, deliveryStatus);
      }
    });
  }

  async #withCurrentSourceView(
    input: AgentStartRequest,
    signal: AbortSignal,
    action: () => void | Promise<void>,
  ): Promise<void> {
    await this.options.chatMutationLock.runExclusive(
      `chat:${input.sourceChatId}`,
      async () => {
        signal.throwIfAborted();
        if (!this.#sourceViewIsCurrent(input)) return;
        await action();
      },
    );
  }

  #appendOutcome(
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
    this.#emitDiagnostic({
      ...diagnosticContext(input),
      event: 'result-delivery',
      status: deliveryStatus,
      itemCount: results.length,
    });
  }

  #emitDiagnostic(event: AgentStartDiagnosticEvent): void {
    try {
      this.options.onDiagnostic?.(event);
    } catch {
      // Observability must not change command execution.
    }
  }

  #sourceViewIsCurrent(input: AgentStartRequest): boolean {
    if (!this.options.registry.getChat(input.sourceChatId)) return false;
    return this.options.notices.currentView(input.sourceChatId)?.viewId === input.sourceViewId;
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

function diagnosticContext(input: AgentStartRequest): AgentStartDiagnosticContext {
  return {
    sourceChatId: input.sourceChatId,
    sourceViewId: input.sourceViewId,
    requestRunId: input.requestRunId,
  };
}

function errorContext(
  input: AgentStartRequest,
  phase: AgentStartErrorContext['phase'],
): AgentStartErrorContext {
  return { ...diagnosticContext(input), phase };
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
