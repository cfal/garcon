import crypto from 'crypto';
import { AssistantMessage, CompactionMessage, ErrorMessage } from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { extractCompactionSummary, isCompactionSummaryText, parseCompactMetadata } from "./compaction.js";
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { convertClaudePermissionTool } from "./permission-tool-converter.js";
import { ClaudeCliVersionProbe } from "./cli-version.js";
import {
  type AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import type {
  AgentSteerRequest,
  AgentSteerResult,
  AgentSteerTarget,
} from '@garcon/server-agent-interface';
import type { ClaudeThinkingMode, PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import {
  assertClaudeExecutionOpen,
  type ClaudeProjectPathUpdate,
  type ClaudeResumeRequest,
  type ClaudeStartRequest,
} from './runtime-types.js';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { isRecord } from '@garcon/common/json';
import { isManualBypassMode, providerStartupPermissionMode } from '@garcon/server-agent-common/execution/permission-modes';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import { ClaudeProcessRetirementTracker } from './process-retirements.js';
import { ClaudeControlBroker } from './cli-control.js';
import {
  buildClaudeCLIArgs,
  runSingleQuery,
  type ClaudeCliDependencies,
} from './cli-invocation.js';
import { buildClaudePermissionApprovalResponse, isClaudeAskUserQuestionTool } from './permission-response.js';
import {
  mergeClaudeSessionOptions,
  normalizeClaudeThinkingModeForState,
  type ClaudeSessionOptions,
} from './session-options.js';
import {
  ClaudeProcessTransport,
  type ClaudeProcessExit,
  type ClaudeTransportFailure,
} from './cli-process-transport.js';
import {
  claudeResultFailureMessage,
  convertCLIMessageToChatMessages,
  type ClaudeCLIMessage,
  type ClaudeTurnTerminalState,
} from './cli-protocol.js';
import {
  flushDeferredClaudeProviderIdle,
  handleClaudeProviderLifecycleMessage,
  type ClaudeProviderStateHandlers,
} from './cli-session-state.js';
import { ClaudeActiveTurn } from './active-turn.js';
import {
  buildClaudeInitialUserContent,
  buildClaudeUserInputFrame,
} from './user-input.js';
import { handleClaudeInterruptReceipt } from './interrupt-receipt.js';
import { ClaudeTurnPublisher } from './turn-publisher.js';
import { materializeClaudeVideoAttachments } from './video-attachments.js';
import {
  CLAUDE_STEER_IDLE_FENCE_TIMEOUT_MS,
  CLAUDE_STEER_WRITE_TIMEOUT_MS,
  ClaudeSteeringController,
} from './steering.js';
import {
  INTERRUPT_COMPLETION_TIMEOUT_MS,
  INTERRUPT_RECEIPT_TIMEOUT_MS,
  NOOP_LOGGER,
  type ClaudeRunningSession,
  type InterruptFallbackStage,
  type PendingPermission,
} from './runtime-state.js';

const CONVERSATION_RESET_FAILURE = 'Claude CLI cleared the conversation mid-turn. The chat transcript is unchanged; send the message again to continue from it.';

class ClaudeCliRuntime {
  #runningSessions = new Map<string, ClaudeRunningSession>();
  #processRetirements = new ClaudeProcessRetirementTracker();
  #pendingPermissions = new Set<PendingPermission>();
  #controlBroker: ClaudeControlBroker;
  #steering: ClaudeSteeringController;
  #turnPublisher: ClaudeTurnPublisher;
  #idlePurger: IdleSessionPurger<ClaudeRunningSession>;
  #shuttingDown = false;
  readonly #dependencies: ClaudeCliDependencies;

  constructor(dependencies: ClaudeCliDependencies = defaultClaudeCliDependencies()) {
    this.#dependencies = dependencies;
    this.#turnPublisher = new ClaudeTurnPublisher(dependencies.logger);
    this.#controlBroker = new ClaudeControlBroker(
      (agentSessionId, jsonl) => this.#writeToCLI(agentSessionId, jsonl),
    );
    this.#steering = new ClaudeSteeringController({
      session: agentSessionId => this.#runningSessions.get(agentSessionId) ?? null,
      isShuttingDown: () => this.#shuttingDown,
      logger: dependencies.logger,
      writeTimeoutMs: dependencies.steerWriteTimeoutMs ?? CLAUDE_STEER_WRITE_TIMEOUT_MS,
      flushDeferredIdle: (session, activeTurn) => {
        const runningSession = this.#runningSessions.get(session.id);
        if (!runningSession || runningSession.activeTurn !== activeTurn) return;
        this.#flushDeferredProviderIdle(runningSession, runningSession.activeTurn);
      },
    });
    this.#idlePurger = new IdleSessionPurger({
      sessions: () => this.#runningSessions.entries(),
      isRunning: (session) => session.activeTurn !== null,
      lastActivityAt: (session) => session.lastActivityAt,
      purge: (id, session) => this.#evictIdleSession(id, session),
    });
  }

  /** Shallow comparison of env override maps; treats undefined and {} as equal. */
  #envOverridesChanged(a?: Record<string, string>, b?: Record<string, string>): boolean {
    const keysA = Object.keys(a ?? {});
    const keysB = Object.keys(b ?? {});
    if (keysA.length !== keysB.length) return true;
    for (const k of keysA) {
      if (a![k] !== b?.[k]) return true;
    }
    return false;
  }

  #beginTurn(
    session: ClaudeRunningSession,
    operation: AgentRuntimeOperation,
  ): ClaudeActiveTurn {
    if (session.activeTurn) {
      throw new Error(`Claude session ${session.id} already has an active turn`);
    }
    const activeTurn = new ClaudeActiveTurn(session.backgroundTaskCount, operation);
    session.unownedProviderActivity = false;
    session.activeTurn = activeTurn;
    session.lastActivityAt = activeTurn.startedAt;
    return activeTurn;
  }

  async #writeToCLI(sessionId: string, jsonl: string): Promise<void> {
    const session = this.#runningSessions.get(sessionId);
    if (!session?.transport) {
      throw new Error(`Claude session ${sessionId} has no writable process`);
    }
    await session.transport.writeLine(jsonl);
  }

  #trySendToCLI(sessionId: string, jsonl: string): void {
    void this.#writeToCLI(sessionId, jsonl).catch((err: unknown) => {
      this.#dependencies.logger.warn('Claude CLI stdin write failed', {
        sessionId: sessionId.slice(0, 8),
        error: errorMessage(err),
      });
    });
  }

  #controlResponse(requestId: string | undefined, response: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'control_response',
      response: { request_id: requestId, ...response },
    });
  }

  #routeCLIMessage(
    session: ClaudeRunningSession,
    proc: ReturnType<typeof Bun.spawn>,
    msg: ClaudeCLIMessage,
  ): void {
    if (this.#runningSessions.get(session.id) !== session || session.process !== proc) return;
    const activeTurn = session.activeTurn;
    const inputEvent = activeTurn?.protocol.observeInput(msg) ?? null;
    if (inputEvent?.type === 'started') {
      this.#dependencies.logger.debug('Claude CLI user input started', {
        chatId: session.chatId,
        runId: activeTurn?.operation.runId ?? null,
        sessionId: session.id.slice(0, 8),
        processId: session.process?.pid ?? null,
        inputId: activeTurn?.protocol.inputUuid.slice(0, 8) ?? null,
        source: inputEvent.source,
        submitToStartMs: activeTurn ? Date.now() - activeTurn.startedAt : null,
      });
    } else if (inputEvent?.type === 'terminal-before-start') {
      this.#handleInputTerminalBeforeStart(session, inputEvent.state);
      return;
    }
    const steeringEvent = activeTurn?.steering.observe(msg) ?? null;
    if (steeringEvent) {
      this.#steering.handleObservation(session, activeTurn!, steeringEvent);
    }

    switch (msg.type) {
      case 'system':
        this.#handleSystemMessage(session, msg);
        break;

      case 'assistant': {
        const turn = session.activeTurn;
        if (!turn) return;
        if (!turn.protocol.inputStarted) {
          this.#dependencies.logger.info('Claude CLI emitted assistant output for an internal turn', {
            chatId: session.chatId,
            runId: turn.operation.runId,
            sessionId: session.id.slice(0, 8),
            processId: session.process?.pid ?? null,
          });
          return;
        }
        const chatMessages = convertCLIMessageToChatMessages(msg);
        turn.protocol.addOutputMessages(
          chatMessages.length,
          chatMessages.some((message) => message.type === 'assistant-message'),
        );
        if (chatMessages.length > 0) {
          this.#turnPublisher.messages(session, turn, chatMessages);
        }
        break;
      }

      case 'stream_event':
        break;

      case 'result':
        if (!session.activeTurn) return;
        this.#handleResultMessage(session, msg);
        break;

      case 'control_request':
        this.#handleControlRequest(session, msg);
        break;

      case 'control_cancel_request':
        this.#handleControlCancelRequest(session, msg);
        break;

      case 'control_response':
        this.#handleControlResponse(session, msg);
        break;

      case 'command_lifecycle':
        break;

      case 'conversation_reset':
        this.#handleConversationReset(session, msg);
        break;

      case 'user':
        if (!session.activeTurn) return;
        this.#handleUserMessage(session, msg);
        break;

      case 'tool_progress':
      case 'tool_use_summary':
      case 'auth_status':
      case 'keep_alive':
        break;

      default:
        this.#dependencies.logger.info('Claude CLI emitted an unrecognized message type', {
          messageType: msg.type,
        });
        break;
    }
  }

  #handleSystemMessage(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    if (handleClaudeProviderLifecycleMessage(
      msg,
      session,
      this.#providerStateHandlers(session),
    )) return;

    const activeTurn = session.activeTurn;
    if (msg.subtype === 'init') {
      this.#dependencies.logger.info('Claude CLI session initialized', {
        chatId: session.chatId,
        runId: activeTurn?.operation.runId ?? null,
        sessionId: session.id.slice(0, 8),
        processId: session.process?.pid ?? null,
        providerSessionId: msg.session_id ?? '',
        model: msg.model ?? '',
      });
      if (session.id !== msg.session_id) {
        this.#failSession(session, `Unexpected Claude session ID: ${msg.session_id || 'missing'}`);
        this.#retireSessionProcessInBackground(session);
      }
      return;
    }

    if (msg.subtype === 'api_retry') {
      if (!activeTurn) return;
      const retry = activeTurn.protocol.recordApiRetry(msg);
      this.#dependencies.logger.warn('Claude API request is retrying', {
        chatId: session.chatId,
        runId: activeTurn.operation.runId,
        sessionId: session.id.slice(0, 8),
        processId: session.process?.pid ?? null,
        matchedUserInput: activeTurn.protocol.inputStarted,
        ...retry,
      });
      return;
    }

    if (msg.subtype === 'status' && msg.compact_result === 'failed') {
      if (!activeTurn?.protocol.inputStarted) return;
      activeTurn.pendingCompaction = undefined;
      const reason = msg.compact_error || 'Compaction failed';
      activeTurn.protocol.addOutputMessages(1);
      this.#turnPublisher.messages(
        session,
        activeTurn,
        [new ErrorMessage(new Date().toISOString(), reason)],
      );
      return;
    }

    if (msg.subtype === 'compact_boundary') {
      if (!activeTurn?.protocol.inputStarted) return;
      activeTurn.pendingCompaction = parseCompactMetadata(msg.compact_metadata);
    }
  }

  // A CLI-side flow (for example a forwarded /clear) discarded the conversation; the frame's
  // new_conversation_id names that fresh conversation, not a session id. Garcon has no durable
  // context-reset boundary, so the turn fails and the process retires while the chat keeps its
  // native binding; the retired process's identity guard drops the post-reset re-initialization
  // that would otherwise misread as a session mismatch.
  // https://github.com/anthropics/claude-agent-sdk-python/blob/a8b1e285/src/claude_agent_sdk/types.py#L1417-L1440
  #handleConversationReset(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    const activeTurn = session.activeTurn;
    this.#dependencies.logger.warn('Claude CLI discarded the conversation', {
      chatId: session.chatId,
      runId: activeTurn?.operation.runId ?? null,
      sessionId: session.id.slice(0, 8),
      processId: session.process?.pid ?? null,
      newConversationId: msg.new_conversation_id ?? null,
    });
    if (activeTurn) {
      activeTurn.protocol.clearRecordedResultFailure();
      this.#failSession(session, CONVERSATION_RESET_FAILURE);
    }
    this.#retireSessionProcessInBackground(session);
  }

  #providerStateHandlers(session: ClaudeRunningSession): ClaudeProviderStateHandlers {
    return {
      logger: this.#dependencies.logger,
      finish: () => this.#finishTurn(session),
      fail: message => this.#failSession(session, message),
      retire: () => this.#retireSessionProcessInBackground(session),
      steeringIdleFenceTimeoutMs:
        this.#dependencies.steerIdleFenceTimeoutMs ?? CLAUDE_STEER_IDLE_FENCE_TIMEOUT_MS,
    };
  }

  #flushDeferredProviderIdle(
    session: ClaudeRunningSession,
    activeTurn: ClaudeActiveTurn,
  ): void {
    if (session.activeTurn !== activeTurn) return;
    flushDeferredClaudeProviderIdle(session, this.#providerStateHandlers(session));
  }

  // Folds the post-compaction summary (delivered as a synthetic user message)
  // into a CompactionMessage, pairing it with the metadata from the preceding
  // compact_boundary. Replayed user prompts carry no rendered output, while
  // provider tool results are canonical live output.
  #handleUserMessage(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn?.protocol.inputStarted) return;

    const chatMessages = convertCLIMessageToChatMessages(msg);
    if (chatMessages.length > 0) {
      activeTurn.protocol.addOutputMessages(chatMessages.length);
      this.#turnPublisher.messages(session, activeTurn, chatMessages);
    }

    if (!activeTurn.pendingCompaction) return;

    const content = msg.message?.content;
    const text = typeof content === 'string' ? content : '';
    if (!isCompactionSummaryText(text)) return;

    const pending = activeTurn.pendingCompaction;
    activeTurn.pendingCompaction = undefined;

    activeTurn.protocol.addOutputMessages(1);
    // The compaction occurrence's canonical identity is the summary record's
    // uuid, the same identity the JSONL loader binds to its CompactionMessage,
    // so the live and imported rows are one occurrence across restart/audit.
    const compactionMessage = new CompactionMessage(
      new Date().toISOString(),
      pending.trigger,
      extractCompactionSummary(text),
      pending.preTokens,
      pending.postTokens,
    );
    // Match the JSONL loader's compaction identity: the summary uuid at ordinal 0.
    if (typeof msg.uuid === 'string' && msg.uuid) attachNativeMessageSource(compactionMessage, { entryId: msg.uuid, withinSourceOrdinal: 0 });
    this.#turnPublisher.messages(session, activeTurn, [compactionMessage]);
  }

  // Cancels the pending force-kill fallback armed by an abort. Safe to call
  // when none is armed.
  #clearAbortTimer(session: ClaudeRunningSession): void {
    const activeTurn = session.activeTurn;
    if (activeTurn?.abortTimer) {
      clearTimeout(activeTurn.abortTimer);
      activeTurn.abortTimer = null;
    }
  }

  #handleResultMessage(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn) return;
    const protocol = activeTurn.protocol;
    const resultDetails = {
      chatId: session.chatId,
      runId: activeTurn.operation.runId,
      sessionId: session.id.slice(0, 8),
      processId: session.process?.pid ?? null,
      inputId: protocol.inputUuid.slice(0, 8),
      resultInputId: msg.user_message_uuid?.slice(0, 8) ?? null,
      outcome: msg.subtype ?? (msg.is_error ? 'error' : 'unknown'),
      isError: Boolean(msg.is_error),
      apiErrorStatus: msg.api_error_status ?? null,
      terminalReason: msg.terminal_reason ?? null,
      stopReason: msg.stop_reason ?? null,
      durationMs: msg.duration_ms ?? null,
      numTurns: msg.num_turns ?? null,
      outputMessages: protocol.outputMessageCount,
      hasResult: typeof msg.result === 'string' && msg.result.trim().length > 0,
      permissionDenials: msg.permission_denials?.length ?? 0,
    };

    const correlation = protocol.correlateResult(msg);
    if (correlation === 'before-start') {
      protocol.recordResultBeforeStart(msg);
      if (msg.is_error) {
        this.#dependencies.logger.warn(
          'Claude CLI emitted an uncorrelated result while user input was pending',
          resultDetails,
        );
      } else {
        this.#dependencies.logger.info(
          'Claude CLI emitted an uncorrelated result while user input was pending',
          resultDetails,
        );
      }
      return;
    }
    if (correlation === 'mismatched') {
      this.#dependencies.logger.warn('Claude CLI emitted a result for another user input', resultDetails);
      return;
    }

    const resultText = typeof msg.result === 'string' ? msg.result.trim() : '';
    if (!msg.is_error && !protocol.assistantContentSinceLastResult && resultText) {
      protocol.addOutputMessages(1, true);
      this.#turnPublisher.messages(
        session,
        activeTurn,
        [new AssistantMessage(new Date().toISOString(), resultText)],
      );
    }
    protocol.recordAcceptedResult(msg);
    const resultLog = correlation === 'input'
      ? 'Claude CLI input result received; awaiting provider idle'
      : 'Claude CLI continuation result received; awaiting provider idle';
    if (msg.is_error && !protocol.cleanAbortResultSeen) {
      this.#dependencies.logger.warn(resultLog, resultDetails);
    } else {
      this.#dependencies.logger.info(resultLog, resultDetails);
    }
  }

  #handleInputTerminalBeforeStart(
    session: ClaudeRunningSession,
    state: ClaudeTurnTerminalState,
  ): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn) return;
    const result = activeTurn.protocol.takeResultBeforeStart();
    const abortRequested = activeTurn.protocol.abortRequested;
    const details = {
      chatId: session.chatId,
      runId: activeTurn.operation.runId,
      sessionId: session.id.slice(0, 8),
      processId: session.process?.pid ?? null,
      inputId: activeTurn.protocol.inputUuid.slice(0, 8),
      state,
      abortRequested,
      precedingResultOutcome: result?.subtype ?? null,
      precedingResultWasError: Boolean(result?.is_error),
    };

    if (state === 'cancelled' && abortRequested) {
      this.#dependencies.logger.info('Claude CLI cancelled queued user input after an interrupt', details);
      activeTurn.confirmPreStartAbort();
      this.#finishTurn(session);
      return;
    }
    this.#dependencies.logger.warn('Claude CLI submitted input ended before starting', details);
    if (result?.is_error) {
      this.#failSession(session, claudeResultFailureMessage(result));
      return;
    }

    const failure = state === 'completed'
      ? 'Claude CLI marked the submitted message complete without starting it or producing a response.'
      : `Claude CLI ${state} the submitted message before it started.`;
    this.#failSession(session, failure);
  }

  #cancelPendingPermissions(session: ClaudeRunningSession): void {
    for (const pending of [...this.#pendingPermissions]) {
      if (pending.agentSessionId !== session.id) continue;
      this.#pendingPermissions.delete(pending);
      this.#turnPublisher.event(session, pending.turn, {
        type: 'permission',
        runId: pending.turn.operation.runId,
        lifecycle: {
          kind: 'cancelled',
          permissionOccurrenceId: pending.permissionOccurrenceId,
          reason: 'cancelled',
        },
      });
    }
  }

  #handleControlRequest(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    const request = msg.request;
    const subtype = request?.subtype;
    if (!request || subtype !== 'can_use_tool') {
      this.#trySendToCLI(session.id, this.#controlResponse(msg.request_id, {
        subtype: 'error',
        error: `Unsupported control request subtype: ${subtype || 'missing'}`,
      }));
      return;
    }
    const activeTurn = session.activeTurn;
    if (!activeTurn?.protocol.inputStarted) {
      this.#dependencies.logger.warn('Dropped an unnamed Claude permission event', {
        chatId: session.chatId,
        eventType: 'permission',
        reason: 'missing active operation',
      });
      this.#trySendToCLI(session.id, this.#controlResponse(msg.request_id, {
        subtype: 'error',
        error: 'Claude tool permission arrived outside the active Garcon turn',
      }));
      return;
    }

    const permissionOccurrenceId = crypto.randomUUID();
    const toolName = request.tool_name || 'Unknown';
    const toolInput = request.input || {};
    const toolUseId = request.tool_use_id;

    if (isManualBypassMode(session.currentPermissionMode) && !isClaudeAskUserQuestionTool(toolName)) {
      const response = buildClaudePermissionApprovalResponse(
        { toolName, toolInput, toolUseId },
        { allow: true, alwaysAllow: false },
      );
      this.#trySendToCLI(session.id, this.#controlResponse(msg.request_id, {
        subtype: 'success',
        response,
      }));
      return;
    }

    const pending: PendingPermission = {
      permissionOccurrenceId,
      cliRequestId: msg.request_id!,
      agentSessionId: session.id,
      toolName,
      toolInput,
      toolUseId,
      turn: activeTurn,
    };
    this.#pendingPermissions.add(pending);

    const now = new Date().toISOString();
    const requestedTool = convertClaudePermissionTool(
      now,
      toolUseId ?? permissionOccurrenceId,
      toolName,
      request.input,
    );
    this.#turnPublisher.event(session, activeTurn, {
      type: 'permission',
      runId: activeTurn.operation.runId,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId,
        requestedTool,
        options: [],
      },
      decision: Object.freeze({
        permissionOccurrenceId,
        respond: (decision: PermissionDecisionPayload) => (
          this.#resolvePendingPermission(pending, decision)
        ),
      }),
    });
  }

  #handleControlCancelRequest(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    if (msg.request_id) {
      for (const pending of this.#pendingPermissions) {
        if (pending.agentSessionId !== session.id || pending.cliRequestId !== msg.request_id) continue;
        this.#pendingPermissions.delete(pending);
        this.#turnPublisher.event(session, pending.turn, {
          type: 'permission',
          runId: pending.turn.operation.runId,
          lifecycle: {
            kind: 'cancelled',
            permissionOccurrenceId: pending.permissionOccurrenceId,
            reason: 'cancelled',
          },
        });
        return;
      }
    }
    this.#dependencies.logger.warn('Dropped an unnamed Claude permission event', {
      chatId: session.chatId,
      eventType: 'permission',
      reason: 'missing permission occurrence',
    });
  }

  #handleControlResponse(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    this.#controlBroker.handleResponse(session.id, msg);
  }

  async #retireSessionProcess(session: ClaudeRunningSession): Promise<void> {
    this.#clearAbortTimer(session);
    this.#controlBroker.rejectSession(session.id, 'Claude CLI process was retired');
    const proc = session.process;
    const transport = session.transport;
    if (!proc || !transport) {
      await session.retirement;
      return;
    }
    session.process = null;
    session.transport = null;
    const priorRetirement = session.retirement ?? Promise.resolve();
    const retirement = priorRetirement.then(() => transport.retire());
    session.retirement = retirement;
    const processExit = proc.exited.then(() => {
      if (session.retirement === retirement) session.retirement = null;
    });
    this.#processRetirements.track(session.id, session.chatId, processExit);
    await retirement;
  }

  #retireSessionProcessInBackground(session: ClaudeRunningSession): void {
    void this.#retireSessionProcess(session).catch((error: unknown) => {
      this.#dependencies.logger.error('Claude CLI process retirement failed', {
        chatId: session.chatId,
        sessionId: session.id.slice(0, 8),
        error: errorMessage(error),
      });
    });
  }

  async #retireSession(session: ClaudeRunningSession): Promise<void> {
    const activeTurn = session.activeTurn;
    this.#clearAbortTimer(session);
    session.activeTurn = null;
    activeTurn?.finish();
    this.#completeSessionInitialization(session);

    this.#cancelPendingPermissions(session);
    await this.#retireSessionProcess(session);
  }

  #completeSessionInitialization(session: ClaudeRunningSession): void {
    const complete = session.completeInitialization;
    session.completeInitialization = null;
    session.initialization = null;
    complete?.();
  }

  #failSession(session: ClaudeRunningSession, message: string): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn) return;
    message = activeTurn.protocol.recordedResultFailureMessage ?? message;
    this.#clearAbortTimer(session);
    session.activeTurn = null;
    this.#controlBroker.rejectSession(session.id, 'Claude turn settled', 'interrupt');
    this.#cancelPendingPermissions(session);
    session.lastActivityAt = Date.now();
    this.#turnPublisher.failed(session, activeTurn, message);
    activeTurn.finish();
  }

  #finishTurn(session: ClaudeRunningSession): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn) return;
    this.#clearAbortTimer(session);
    session.activeTurn = null;
    if (!activeTurn.protocol.abortRequested) {
      this.#controlBroker.rejectSession(session.id, 'Claude turn settled', 'interrupt');
    }
    this.#cancelPendingPermissions(session);
    session.lastActivityAt = Date.now();
    this.#turnPublisher.finished(session, activeTurn);
    activeTurn.finish();
  }

  #evictIdleSession(id: string, session: ClaudeRunningSession): void {
    this.#runningSessions.delete(id);
    void this.#retireSession(session).catch((error: unknown) => {
      this.#dependencies.logger.error('Claude idle process retirement failed', {
        sessionId: session.id.slice(0, 8),
        error: errorMessage(error),
      });
    });
  }

  async prepareClaudeProjectPathUpdate(request: ClaudeProjectPathUpdate): Promise<void> {
    const agentSessionId = request.agentSessionId;
    if (!agentSessionId) return;

    const session = this.#runningSessions.get(agentSessionId);
    if (session && session.chatId !== request.chatId) {
      throw new Error('Chat ID mismatch');
    }
    if (session?.activeTurn) {
      throw new Error('Cannot update project path while Claude is running');
    }
    for (const pending of this.#pendingPermissions) {
      if (pending.agentSessionId === agentSessionId) {
        throw new Error('Cannot update project path while Claude is waiting for permission');
      }
    }

    if (session) {
      this.#clearAbortTimer(session);
      await this.#retireSessionProcess(session);
    }
    await this.#processRetirements.wait(agentSessionId, request.chatId);
  }

  setInternalPermissionMode(agentSessionId: string, mode: PermissionMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.currentPermissionMode = mode;
    session.options = { ...session.options, permissionMode: mode };

    if (session.process) {
      const providerMode = providerStartupPermissionMode(mode);
      this.#controlBroker.request(session.id, {
        subtype: 'set_permission_mode',
        mode: providerMode,
      }).catch((error: unknown) => {
        this.#dependencies.logger.warn('Claude CLI permission-mode update failed', {
          sessionId: agentSessionId.slice(0, 8),
          error: errorMessage(error),
        });
      });
    }
  }

  setInternalThinkingMode(agentSessionId: string, mode: ThinkingMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.options = { ...session.options, thinkingMode: mode };

    if (session.process && !session.activeTurn) {
      this.#retireSessionProcessInBackground(session);
    }
  }

  setInternalClaudeThinkingMode(agentSessionId: string, mode: ClaudeThinkingMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.options = { ...session.options, claudeThinkingMode: mode };

    if (session.process && !session.activeTurn) {
      this.#retireSessionProcessInBackground(session);
    }
  }

  async #resolvePendingPermission(
    pending: PendingPermission,
    decision: PermissionDecisionPayload,
  ): Promise<void> {
    if (!this.#pendingPermissions.has(pending)) {
      throw new Error('Claude permission occurrence is no longer pending');
    }
    const response = buildClaudePermissionApprovalResponse(pending, decision);
    await this.#writeToCLI(pending.agentSessionId, this.#controlResponse(pending.cliRequestId, {
      subtype: 'success',
      response,
    }));
    this.#pendingPermissions.delete(pending);
  }

  async #sendUserMessage(
    session: ClaudeRunningSession,
    activeTurn: ClaudeActiveTurn,
    command: string,
    images?: readonly AgentAttachment[],
  ): Promise<void> {
    await this.#writeToCLI(session.id, buildClaudeUserInputFrame({
      content: buildClaudeInitialUserContent(command, images),
      sessionId: session.id || '',
      uuid: activeTurn.protocol.inputUuid,
    }));
  }

  captureSteerTarget(agentSessionId: string): AgentSteerTarget | null {
    return this.#steering.captureTarget(agentSessionId);
  }

  steer(request: AgentSteerRequest): Promise<AgentSteerResult> {
    return this.#steering.steer(request);
  }

  #waitForTurnComplete(activeTurn: ClaudeActiveTurn): Promise<void> {
    return activeTurn.completion;
  }

  #buildCLIArgs(
    session: ClaudeRunningSession,
    options: ClaudeSessionOptions,
    resume: boolean,
  ): string[] {
    return buildClaudeCLIArgs({
      model: options.model,
      permissionMode: options.permissionMode,
      thinkingMode: options.thinkingMode,
      claudeThinkingMode: options.claudeThinkingMode,
      prompt: '',
      streamJson: true,
      sessionId: resume ? undefined : session.id,
      resumeSessionId: resume ? session.id : undefined,
    });
  }

  #handleTransportFailure(
    session: ClaudeRunningSession,
    proc: ReturnType<typeof Bun.spawn>,
    failure: ClaudeTransportFailure,
  ): void {
    if (session.process !== proc) return;
    const activeTurn = session.activeTurn;
    this.#dependencies.logger.error('Claude CLI transport failed', {
      chatId: session.chatId,
      runId: activeTurn?.operation.runId ?? null,
      sessionId: session.id.slice(0, 8),
      processId: proc.pid ?? null,
      failureKind: failure.kind,
      error: failure.message,
    });
    if (activeTurn) {
      activeTurn.markInterruptRequestFailed();
      this.#controlBroker.rejectSession(
        session.id,
        `Claude CLI ${failure.kind} transport failed: ${failure.message}`,
        'interrupt',
      );
      this.#failSession(session, `Claude CLI ${failure.kind} failed: ${failure.message}`);
    }
    this.#retireSessionProcessInBackground(session);
  }

  #handleStdoutEof(
    session: ClaudeRunningSession,
    proc: ReturnType<typeof Bun.spawn>,
  ): void {
    if (session.process !== proc || !session.activeTurn) return;
    this.#dependencies.logger.error('Claude CLI stdout ended during an active turn', {
      chatId: session.chatId,
      runId: session.activeTurn.operation.runId,
      sessionId: session.id.slice(0, 8),
      processId: proc.pid ?? null,
    });
    session.activeTurn.markInterruptRequestFailed();
    this.#controlBroker.rejectSession(
      session.id,
      'Claude CLI stdout ended during an active turn',
      'interrupt',
    );
    this.#failSession(
      session,
      'Claude CLI stdout ended before the submitted message produced a terminal result.',
    );
    this.#retireSessionProcessInBackground(session);
  }

  #handleProcessExit(
    session: ClaudeRunningSession,
    proc: ReturnType<typeof Bun.spawn>,
    exit: ClaudeProcessExit,
  ): void {
    if (session.process !== proc) {
      return;
    }

    const { exitCode } = exit;
    session.process = null;
    session.transport = null;
    session.lastActivityAt = Date.now();
    this.#clearAbortTimer(session);
    this.#controlBroker.rejectSession(session.id, `Claude CLI process exited with code ${exitCode}`);
    const activeTurn = session.activeTurn;
    this.#cancelPendingPermissions(session);

    if (activeTurn) {
      activeTurn.markInterruptRequestFailed();
      this.#failSession(session, `Claude CLI process exited with code ${exitCode}`);
    }
  }

  async #spawnCLI(
    session: ClaudeRunningSession,
    options: ClaudeSessionOptions,
    resume: boolean,
    cliVersion: readonly [number, number, number],
  ): Promise<ReturnType<typeof Bun.spawn>> {
    await session.retirement;
    await this.#processRetirements.wait(session.id, session.chatId);
    if (session.process || session.transport) {
      throw new Error(`Claude session ${session.id} already has a process`);
    }
    const claudeBinary = this.#dependencies.binary();
    const args = this.#buildCLIArgs(session, options, resume);

    this.#dependencies.logger.info('Spawning Claude CLI', {
      binary: claudeBinary,
      chatId: session.chatId,
      sessionId: session.id.slice(0, 8),
      resumed: resume,
      cliVersion: cliVersion.join('.'),
    });

    const proc = Bun.spawn([claudeBinary, ...args], {
      cwd: options.projectPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: (() => {
        const { CLAUDECODE, ...env } = process.env;
        return {
          ...env,
          ...options.envOverrides,
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        };
      })(),
    });

    session.options = options;
    session.providerState = 'unknown';
    session.backgroundTaskCount = 0;
    session.unownedProviderActivity = false;
    session.process = proc;
    session.currentThinkingMode = options.thinkingMode || 'none';
    session.currentClaudeThinkingMode = normalizeClaudeThinkingModeForState(options.claudeThinkingMode);
    session.currentModel = options.model || '';
    session.currentEnvOverrides = options.envOverrides;
    const transport = new ClaudeProcessTransport<ClaudeCLIMessage>({
      process: proc,
      logger: this.#dependencies.logger,
      sessionId: session.id,
      onMessage: msg => this.#routeCLIMessage(session, proc, msg),
      onFailure: failure => this.#handleTransportFailure(session, proc, failure),
      onEof: () => this.#handleStdoutEof(session, proc),
      onExit: exit => {
        const exitedDuringTurn = session.process === proc
          && session.activeTurn !== null;
        const activeTurn = session.activeTurn;
        const details = {
          chatId: session.chatId,
          runId: activeTurn?.operation.runId ?? null,
          sessionId: session.id.slice(0, 8),
          processId: proc.pid ?? null,
          exitCode: exit.exitCode,
          stderrBytes: exit.stderrBytes,
          stderrLines: exit.stderrLines,
          stderrRetainedBytes: exit.stderrRetainedBytes,
          stderrTailDigest: exit.stderrTailDigest,
          stderrTruncated: exit.stderrTruncated,
          duringTurn: exitedDuringTurn,
        };
        if (exitedDuringTurn) {
          this.#dependencies.logger.error('Claude CLI process exited during an active turn', details);
        } else {
          this.#dependencies.logger.info('Claude CLI process exited', details);
        }
        this.#handleProcessExit(session, proc, exit);
      },
    });
    session.transport = transport;
    try {
      const initializeStartedAt = Date.now();
      const initializeResponse = await this.#controlBroker.request(
        session.id,
        { subtype: 'initialize' },
        { timeoutMs: 60_000 },
      );
      const initializeInfo = isRecord(initializeResponse) ? initializeResponse : {};
      this.#dependencies.logger.info('Claude CLI control protocol initialized', {
        chatId: session.chatId,
        sessionId: session.id.slice(0, 8),
        processId: proc.pid ?? null,
        durationMs: Date.now() - initializeStartedAt,
        commandCount: Array.isArray(initializeInfo.commands)
          ? initializeInfo.commands.length
          : 0,
      });
    } catch (error) {
      await this.#retireSessionProcess(session);
      throw error;
    }

    return proc;
  }

  async startClaudeCliSession(request: ClaudeStartRequest): Promise<string> {
    assertClaudeExecutionOpen(request);
    const {
      command,
      agentSessionId,
      chatId,
      images,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      claudeThinkingMode,
      envOverrides,
      executionAdmission,
      operation,
    } = request;
    const requestAdmission = { executionAdmission };
    if (!chatId) throw new Error('chatId is required when starting a Claude session');
    if (!agentSessionId) throw new Error('agentSessionId is required when starting a Claude session');

    const allOpts: ClaudeSessionOptions = {
      agentSessionId,
      sessionId: agentSessionId,
      chatId,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      claudeThinkingMode,
      envOverrides,
    };

    let completeInitialization: (() => void) | null = null;
    const initialization = new Promise<void>((resolve) => {
      completeInitialization = resolve;
    });
    const session: ClaudeRunningSession = {
      id: agentSessionId,
      chatId,
      initialization,
      completeInitialization,
      lastActivityAt: Date.now(),
      providerState: 'unknown',
      backgroundTaskCount: 0,
      unownedProviderActivity: false,
      activeTurn: null,
      process: null,
      transport: null,
      retirement: null,
      options: allOpts,
      currentPermissionMode: permissionMode || 'default',
      currentThinkingMode: thinkingMode || 'none',
      currentClaudeThinkingMode: normalizeClaudeThinkingModeForState(claudeThinkingMode),
      currentModel: model || '',
      currentEnvOverrides: envOverrides,
    };
    const activeTurn = this.#beginTurn(session, operation);

    const previous = this.#runningSessions.get(agentSessionId);
    if (previous) await this.#retireSession(previous);
    this.#runningSessions.set(agentSessionId, session);
    request.onSessionActivated?.();

    let cliVersion: readonly [number, number, number];
    try {
      cliVersion = await this.#dependencies.versionProbe.assertCompatible(this.#dependencies.binary());
    } catch (error) {
      if (this.#runningSessions.get(agentSessionId) === session) {
        session.activeTurn = null;
        activeTurn.finish();
        this.#runningSessions.delete(agentSessionId);
      }
      this.#completeSessionInitialization(session);
      throw error;
    }
    // Another start may supersede this one while the version probe is pending.
    if (this.#runningSessions.get(agentSessionId) !== session) return agentSessionId;

    let cleanupVideoAttachments = async () => {};
    try {
      assertClaudeExecutionOpen(requestAdmission);
      await this.#spawnCLI(session, allOpts, false, cliVersion);
      assertClaudeExecutionOpen(requestAdmission);
      const prepared = await materializeClaudeVideoAttachments(command, images);
      cleanupVideoAttachments = prepared.cleanup;
      if (executionAdmission) await executionAdmission.markStarted();
      await this.#sendUserMessage(session, activeTurn, prepared.command, images);
      this.#completeSessionInitialization(session);
      await this.#waitForTurnComplete(activeTurn);
    } catch (error) {
      if (this.#runningSessions.get(agentSessionId) === session) {
        await this.#retireSession(session);
        this.#runningSessions.delete(agentSessionId);
      }
      throw error;
    } finally {
      this.#completeSessionInitialization(session);
      await cleanupVideoAttachments();
    }
    return agentSessionId;
  }

  async runClaudeTurn(request: ClaudeResumeRequest): Promise<void> {
    assertClaudeExecutionOpen(request);
    const {
      command,
      agentSessionId,
      chatId,
      images,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      claudeThinkingMode,
      envOverrides,
      executionAdmission,
      operation,
    } = request;
    const requestAdmission = { executionAdmission };
    if (!agentSessionId) {
      throw new Error('Cannot resume without session ID');
    }
    if (!chatId) {
      throw new Error('Cannot resume without chat ID');
    }

    // Resolved before any session-state checks so the spawn path below stays
    // free of interleaving awaits.
    const cliVersion = await this.#dependencies.versionProbe.assertCompatible(this.#dependencies.binary());
    assertClaudeExecutionOpen(requestAdmission);
    if (this.#shuttingDown) throw new Error('Claude runtime is shutting down');

    const allOpts: ClaudeSessionOptions = {
      agentSessionId,
      sessionId: agentSessionId,
      chatId,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      claudeThinkingMode,
      envOverrides,
    };

    let session = this.#runningSessions.get(agentSessionId);
    if (session?.initialization) {
      await session.initialization;
      session = this.#runningSessions.get(agentSessionId);
    }
    if (!session) {
      session = {
        id: agentSessionId,
        chatId: chatId,
        initialization: null,
        completeInitialization: null,
        lastActivityAt: Date.now(),
        providerState: 'unknown',
        backgroundTaskCount: 0,
        unownedProviderActivity: false,
        activeTurn: null,
        process: null,
        transport: null,
        retirement: null,
        options: allOpts,
        currentPermissionMode: permissionMode || 'default',
        currentThinkingMode: thinkingMode || 'none',
        currentClaudeThinkingMode: normalizeClaudeThinkingModeForState(claudeThinkingMode),
        currentModel: model || '',
        currentEnvOverrides: envOverrides,
      };
      this.#runningSessions.set(agentSessionId, session);
    }
    if (this.#shuttingDown) throw new Error('Claude runtime is shutting down');
    if (session.activeTurn?.protocol.abortRequested) {
      await this.#waitForTurnComplete(session.activeTurn);
      assertClaudeExecutionOpen(requestAdmission);
    }
    if (session.activeTurn) {
      throw new Error(`Claude session ${agentSessionId} already has an active turn`);
    }

    let ownedTurn: ClaudeActiveTurn | null = null;
    let cleanupVideoAttachments = async () => {};
    try {
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }

      session.options = mergeClaudeSessionOptions(session.options, allOpts);
      session.chatId = chatId;
      session.lastActivityAt = Date.now();
      const desiredThinkingMode = session.options.thinkingMode || 'none';
      const desiredClaudeThinkingMode = normalizeClaudeThinkingModeForState(
        session.options.claudeThinkingMode,
      );
      const desiredModel = session.options.model || '';
      const desiredPermissionMode = session.options.permissionMode || 'default';
      const previousProviderPermissionMode = session.process
        ? providerStartupPermissionMode(session.currentPermissionMode)
        : 'default';
      const desiredProviderPermissionMode = providerStartupPermissionMode(desiredPermissionMode);
      const permissionStartupChanged = previousProviderPermissionMode !== desiredProviderPermissionMode
        && (
          previousProviderPermissionMode === 'bypassPermissions'
          || desiredProviderPermissionMode === 'bypassPermissions'
        );
      const envChanged = this.#envOverridesChanged(
        session.currentEnvOverrides,
        session.options.envOverrides,
      );
      if (session.process && (
        desiredThinkingMode !== session.currentThinkingMode
        || desiredClaudeThinkingMode !== session.currentClaudeThinkingMode
        || permissionStartupChanged
        || envChanged
      )) {
        await this.#retireSessionProcess(session);
      }

      if (!session.process) {
        // Always resumes because the native transcript owns conversation context.
        assertClaudeExecutionOpen(requestAdmission);
        await this.#spawnCLI(
          session,
          session.options,
          true,
          cliVersion,
        );
      }

      if (session.process && desiredModel !== session.currentModel) {
        await this.#controlBroker.request(session.id, {
          subtype: 'set_model',
          model: desiredModel,
        });
        session.currentModel = desiredModel;
      }

      if (
        session.currentPermissionMode
        && desiredPermissionMode !== session.currentPermissionMode
      ) {
        this.setInternalPermissionMode(agentSessionId, desiredPermissionMode);
      }
      session.currentPermissionMode = desiredPermissionMode;

      // A new turn supersedes any prior abort fallback.
      this.#clearAbortTimer(session);
      assertClaudeExecutionOpen(requestAdmission);
      const activeTurn = this.#beginTurn(session, operation);
      ownedTurn = activeTurn;
      const prepared = await materializeClaudeVideoAttachments(command, images);
      cleanupVideoAttachments = prepared.cleanup;
      if (executionAdmission) await executionAdmission.markStarted();
      await this.#sendUserMessage(session, activeTurn, prepared.command, images);
      await this.#waitForTurnComplete(activeTurn);
    } catch (error) {
      if (ownedTurn && session.activeTurn === ownedTurn) {
        await this.#retireSession(session);
      }
      throw error;
    } finally {
      await cleanupVideoAttachments();
    }
  }

  #forceAbortProcess(
    session: ClaudeRunningSession,
    activeTurn: ClaudeActiveTurn,
    reason: string,
  ): void {
    if (session.activeTurn !== activeTurn) return;
    const process = session.process;
    const transport = session.transport;
    if (!process || !transport) {
      this.#failSession(session, reason);
      return;
    }
    this.#failSession(session, reason);
    if (!process.killed) process.kill();
    this.#retireSessionProcessInBackground(session);
  }

  async abortClaudeInternalSession(agentSessionId: string): Promise<boolean> {
    const session = this.#runningSessions.get(agentSessionId);
    const activeTurn = session?.activeTurn;
    if (!session?.process || !activeTurn) return false;

    activeTurn.protocol.markAbortRequested();
    this.#armAbortFallback(
      session,
      activeTurn,
      INTERRUPT_RECEIPT_TIMEOUT_MS,
      'receipt',
    );
    const receiptCancellation = new AbortController();
    try {
      const response = this.#controlBroker.request(
        session.id,
        {
          subtype: 'interrupt',
          cancel_queued: true,
        },
        { signal: receiptCancellation.signal },
      ).then(value => ({ type: 'receipt' as const, value }));
      const lifecycle = activeTurn.preStartAbortConfirmation.then(
        () => ({ type: 'lifecycle' as const }),
      );
      const completion = activeTurn.completion.then(() => ({ type: 'completion' as const }));
      const acknowledgement = await Promise.race([response, lifecycle, completion]);
      if (acknowledgement.type === 'lifecycle') return true;
      if (acknowledgement.type === 'completion') return false;
      const receipt = acknowledgement.value;
      return handleClaudeInterruptReceipt(session, activeTurn, receipt, {
        logger: this.#dependencies.logger,
        finish: () => this.#finishTurn(session),
        clearAbortTimer: () => this.#clearAbortTimer(session),
        armCompletionFallback: () => this.#armAbortFallback(
          session,
          activeTurn,
          INTERRUPT_COMPLETION_TIMEOUT_MS,
          'completion',
        ),
        flushDeferredIdle: () => this.#flushDeferredProviderIdle(session, activeTurn),
      });
    } catch (error) {
      if (session.activeTurn !== activeTurn) {
        if (activeTurn.interruptRequestFailed) throw error;
        return false;
      }
      this.#dependencies.logger.warn('Claude CLI interrupt request failed', {
        sessionId: agentSessionId.slice(0, 8),
        inputId: activeTurn.protocol.inputUuid.slice(0, 8),
        error: errorMessage(error),
      });
      this.#forceAbortProcess(
        session,
        activeTurn,
        'Claude CLI interrupt request failed.',
      );
      throw error;
    } finally {
      receiptCancellation.abort(new Error('Claude interrupt settled through another signal'));
    }
  }

  #armAbortFallback(
    session: ClaudeRunningSession,
    activeTurn: ClaudeActiveTurn,
    timeoutMs: number,
    stage: InterruptFallbackStage,
  ): void {
    const proc = session.process;
    if (!proc) return;
    this.#clearAbortTimer(session);
    activeTurn.abortTimer = setTimeout(() => {
      activeTurn.abortTimer = null;
      // Fires until Claude confirms cancellation with a correlated terminal event.
      if (session.process === proc && !proc.killed) {
        this.#dependencies.logger.warn('Claude CLI interrupt was not confirmed', {
          sessionId: session.id.slice(0, 8),
          stage,
        });
        if (stage === 'receipt') {
          activeTurn.markInterruptRequestFailed();
          this.#controlBroker.rejectSession(
            session.id,
            'Claude CLI interrupt control request timed out',
            'interrupt',
          );
        }
        this.#forceAbortProcess(
          session,
          activeTurn,
          'Claude CLI did not confirm the interrupt.',
        );
      }
    }, timeoutMs);
  }

  failClaudeInternalSession(
    agentSessionId: string,
    chatId: string,
    message: string,
    operation: AgentRuntimeOperation,
  ): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (session) {
      this.#failSession(session, message);
      this.#retireSessionProcessInBackground(session);
      return;
    }
    try {
      operation.publish({
        type: 'run-ended',
        runId: operation.runId,
        outcome: 'failed',
        error: { code: 'PROVIDER_FAILURE', message },
      });
    } catch (error) {
      this.#dependencies.logger.warn('Claude publisher rejected a failed start event', {
        agentSessionId,
        chatId,
        eventType: 'run-ended',
        error: errorMessage(error),
      });
    }
  }

  isClaudeInternalSessionRunning(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
    return session?.activeTurn !== null && session?.activeTurn !== undefined;
  }

  getRunningClaudeInternalSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#runningSessions.entries())
      .filter(([, session]) => session.activeTurn)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.activeTurn!.startedAt).toISOString(),
      }));
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#idlePurger.stop();
    this.#controlBroker.shutdown('Claude runtime shut down');
    const sessions = [...this.#runningSessions.values()];
    const retirements = await Promise.allSettled(
      sessions.map((session) => this.#retireSession(session)),
    );
    retirements.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      this.#dependencies.logger.error('Claude process shutdown failed', {
        sessionId: sessions[index].id.slice(0, 8),
        error: errorMessage(result.reason),
      });
    });
    this.#runningSessions.clear();
    this.#pendingPermissions.clear();
  }
}

function defaultClaudeCliDependencies(): ClaudeCliDependencies {
  return {
    binary: () => 'claude',
    logger: NOOP_LOGGER,
    versionProbe: new ClaudeCliVersionProbe(),
  };
}

export { ClaudeCliRuntime, buildClaudeCLIArgs, buildClaudePermissionApprovalResponse, convertCLIMessageToChatMessages, runSingleQuery };
export type { ClaudeCliDependencies };
