// Claude CLI transport. Spawns the `claude` binary with stdin/stdout
// pipes, exchanging JSONL messages. Extends AgentEventEmitterRuntime so all output
// flows through typed events wired in the composition root.

import crypto from 'crypto';
import { AssistantMessage, PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage, CompactionMessage, ErrorMessage } from '@garcon/common/chat-types';
import type { ChatMessage, CompactionTrigger } from '@garcon/common/chat-types';
import type { AskUserQuestionDecisionResponse, PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { extractCompactionSummary, isCompactionSummaryText, parseCompactMetadata } from "./compaction.js";
import { convertClaudePermissionTool } from "./permission-tool-converter.js";
import { ClaudeCliVersionProbe } from "./cli-version.js";
import {
  AgentEventEmitterRuntime,
  type RuntimeEventMetadata,
} from '@garcon/server-agent-common/shared/event-emitter-runtime';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import type { ClaudeThinkingMode, PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import {
  assertClaudeExecutionOpen,
  claudeEventMetadata,
  type ClaudeProjectPathUpdate,
  type ClaudeResumeRequest,
  type ClaudeStartRequest,
} from './runtime-types.js';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import { appendTextAttachmentContext, attachmentDocumentBlock, documentAttachments, imageAttachments, parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import { isRecord } from '@garcon/common/json';
import { isManualBypassMode, providerStartupPermissionMode } from '@garcon/server-agent-common/execution/permission-modes';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import { runClaudeSingleQueryProcess } from './single-query-process.js';
import { pipeClaudeProcessOutput } from './cli-stdio.js';
import { ClaudeProjectPathProcessTracker } from './project-path-processes.js';
import { ClaudeControlBroker } from './cli-control.js';
import {
  ClaudeTurnState,
  claudeResultFailureMessage,
  convertCLIMessageToChatMessages,
  type ClaudeCLIMessage,
  type ClaudeTurnTerminalState,
} from './cli-protocol.js';

const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface ClaudeSessionOptions {
  agentSessionId: string;
  sessionId: string;
  chatId: string;
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  images?: readonly AgentAttachment[];
  envOverrides?: Record<string, string>;
}

interface ClaudeRunningSession {
  id: string;
  chatId: string;
  initialization: Promise<void> | null;
  completeInitialization: (() => void) | null;
  lastActivityAt: number;
  activeTurn: ClaudeActiveTurn | null;
  process: ReturnType<typeof Bun.spawn> | null;
  options: ClaudeSessionOptions;
  currentPermissionMode: PermissionMode;
  currentThinkingMode: ThinkingMode;
  currentClaudeThinkingMode: ClaudeThinkingMode;
  currentModel: string;
  currentEnvOverrides?: Record<string, string>;
}

interface ClaudeActiveTurn {
  readonly protocol: ClaudeTurnState;
  readonly eventMetadata: ReturnType<typeof claudeEventMetadata>;
  readonly startedAt: number;
  readonly completion: Promise<void>;
  resolve: (() => void) | null;
  abortTimer: ReturnType<typeof setTimeout> | null;
  abortKilledProc: ReturnType<typeof Bun.spawn> | null;
  // Pairs a compact boundary with the synthetic summary user message.
  pendingCompaction?: { trigger: CompactionTrigger; preTokens?: number; postTokens?: number };
}

function mergeClaudeSessionOptions(
  current: ClaudeSessionOptions,
  next: ClaudeSessionOptions,
): ClaudeSessionOptions {
  return {
    agentSessionId: next.agentSessionId ?? current.agentSessionId,
    sessionId: next.sessionId ?? current.sessionId,
    chatId: next.chatId ?? current.chatId,
    projectPath: next.projectPath ?? current.projectPath,
    model: next.model ?? current.model,
    permissionMode: next.permissionMode ?? current.permissionMode,
    thinkingMode: next.thinkingMode ?? current.thinkingMode,
    claudeThinkingMode: next.claudeThinkingMode ?? current.claudeThinkingMode,
    envOverrides: next.envOverrides ?? current.envOverrides,
    images: next.images,
  };
}

interface PendingPermission {
  cliRequestId: string;
  agentSessionId: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  eventMetadata: RuntimeEventMetadata;
}

interface ClaudeCLIArgOptions {
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  prompt?: string;
  sessionId?: string;
  resumeSessionId?: string;
  streamJson?: boolean;
  supportsLegacyThinkingFlag?: boolean;
}

interface ClaudeSingleQueryOptions {
  model?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClaudeCliDependencies {
  readonly binary: () => string;
  readonly logger: AgentLogger;
  readonly versionProbe: ClaudeCliVersionProbe;
}

function canonicalClaudeToolName(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function isClaudeAskUserQuestionTool(raw: string | undefined): boolean {
  return canonicalClaudeToolName(raw) === 'askuserquestion';
}

function isAskUserQuestionDecisionResponse(
  response: Record<string, unknown> | undefined,
): response is AskUserQuestionDecisionResponse {
  if (!response || response.type !== 'ask-user-question-response') return false;
  return response.outcome === 'answered' || response.outcome === 'skipped';
}

function claudeAskUserQuestionControlResponse(
  pending: Pick<PendingPermission, 'toolInput' | 'toolUseId'>,
  decision: Pick<PermissionDecisionPayload, 'allow' | 'response'>,
): Record<string, unknown> | null {
  if (!isAskUserQuestionDecisionResponse(decision.response)) return null;
  if (!decision.allow || decision.response.outcome === 'skipped') {
    return {
      behavior: 'deny',
      message: decision.response.reason ?? 'User declined to answer questions',
      ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
    };
  }

  const rawQuestions = Array.isArray(pending.toolInput.questions) ? pending.toolInput.questions : [];
  const questions = rawQuestions.map((entry) => isRecord(entry) ? entry : {});
  const answers: Record<string, string> = {};
  const annotations: Record<string, { preview?: string }> = {};

  for (const answer of decision.response.answers) {
    const question = questions.find((candidate) => candidate.question === answer.questionId);
    const questionText = typeof question?.question === 'string' ? question.question : answer.questionId;
    const options = Array.isArray(question?.options)
      ? question.options.map((entry) => isRecord(entry) ? entry : {})
      : [];
    const selectedLabels = answer.selectedOptionIds.map((optionId) => {
      const option = options.find((candidate) => candidate.label === optionId || candidate.id === optionId);
      return typeof option?.label === 'string' ? option.label : optionId;
    });
    answers[questionText] = selectedLabels.join(', ');

    const firstSelectedOption = options.find(
      (option) => option.label === answer.selectedOptionIds[0] || option.id === answer.selectedOptionIds[0],
    );
    if (typeof firstSelectedOption?.preview === 'string') {
      annotations[questionText] = { preview: firstSelectedOption.preview };
    }
  }

  const updatedInput: Record<string, unknown> = {
    ...pending.toolInput,
    answers,
  };
  if (Object.keys(annotations).length > 0) {
    updatedInput.annotations = annotations;
  }

  return {
    behavior: 'allow',
    updatedInput,
    ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
  };
}

// Builds the permission approval/deny response sent back to the CLI.
function buildClaudePermissionApprovalResponse(
  pending: Partial<Pick<PendingPermission, 'toolName' | 'toolInput' | 'toolUseId'>> & { providerToolName?: string; providerToolInput?: Record<string, unknown> },
  decision: Pick<PermissionDecisionPayload, 'allow' | 'alwaysAllow' | 'response'>,
): Record<string, unknown> {
  const toolInput = pending.providerToolInput ?? pending.toolInput ?? {};
  const toolName = pending.providerToolName ?? pending.toolName ?? 'Unknown';
  if (isClaudeAskUserQuestionTool(toolName)) {
    const questionResponse = claudeAskUserQuestionControlResponse(
      { toolInput, toolUseId: pending.toolUseId },
      decision,
    );
    if (questionResponse) return questionResponse;
  }
  if (decision.response) return decision.response;
  if (!decision.allow) {
    return { behavior: 'deny', message: 'Denied by user' };
  }
  const response: Record<string, unknown> = {
    behavior: 'allow',
    updatedInput: toolInput,
  };
  if (decision.alwaysAllow) {
    response.updatedPermissions = [{
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    }];
  }
  return response;
}

// Runs a one-shot CLI query and returns the plain text output.
async function runSingleQuery(
  prompt: string,
  {
    model,
    cwd,
    permissionMode,
    thinkingMode,
    claudeThinkingMode,
    envOverrides,
    timeoutMs,
    signal,
  }: ClaudeSingleQueryOptions = {},
  dependencies: ClaudeCliDependencies = defaultClaudeCliDependencies(),
): Promise<string> {
  return withSingleQueryControl({ signal, timeoutMs }, async (querySignal) => {
    const claudeBinary = dependencies.binary();
    const supportsLegacyThinkingFlag = await dependencies.versionProbe.supportsLegacyThinkingFlag(claudeBinary);
    const args = buildClaudeCLIArgs({ model, permissionMode, thinkingMode, claudeThinkingMode, prompt, supportsLegacyThinkingFlag });

    return runClaudeSingleQueryProcess({
      binary: claudeBinary,
      args,
      cwd: cwd || process.cwd(),
      signal: querySignal,
      envOverrides,
      logger: dependencies.logger,
    });
  });
}

// Forwards non-default effort exactly and leaves unsupported values to the CLI.
function mapThinkingModeToClaudeEffort(thinkingMode: ThinkingMode | undefined): string | undefined {
  const normalizedMode = normalizeThinkingMode(thinkingMode);
  if (normalizedMode === 'none') return undefined;
  return normalizedMode;
}

function normalizeClaudeThinkingModeForState(claudeThinkingMode: ClaudeThinkingMode | undefined): ClaudeThinkingMode {
  return claudeThinkingMode ?? 'auto';
}

function mapClaudeThinkingModeToCliValue(claudeThinkingMode: ClaudeThinkingMode | undefined): string | undefined {
  switch (claudeThinkingMode) {
    case 'auto':
      return 'adaptive';
    case 'on':
      return 'enabled';
    case 'off':
      return 'disabled';
    default:
      return undefined;
  }
}

function buildClaudeCLIArgs({
  model,
  permissionMode,
  thinkingMode,
  claudeThinkingMode,
  prompt = '',
  sessionId,
  resumeSessionId,
  streamJson = false,
  supportsLegacyThinkingFlag = false,
}: ClaudeCLIArgOptions): string[] {
  const args = streamJson
    ? [
        '--print',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--replay-user-messages',
        '--verbose',
      ]
    : ['--print', '--no-session-persistence'];

  if (model) args.push('--model', model);

  const effectiveMode = permissionMode || 'default';
  const providerMode = providerStartupPermissionMode(effectiveMode);
  if (providerMode !== 'default') {
    if (providerMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', providerMode);
    }
  }

  if (streamJson) {
    args.push('--permission-prompt-tool', 'stdio');
  }

  const effort = mapThinkingModeToClaudeEffort(thinkingMode);
  if (effort) {
    args.push('--effort', effort);
  }

  // Claude Code 2.1.198 removed the legacy `--thinking` flag. Forward the
  // mode only when a version probe confirmed the installed CLI still
  // supports it; newer CLIs control thinking via `--effort` above.
  if (supportsLegacyThinkingFlag) {
    const mappedClaudeThinkingMode = mapClaudeThinkingModeToCliValue(claudeThinkingMode);
    if (mappedClaudeThinkingMode) {
      args.push('--thinking', mappedClaudeThinkingMode);
    }
  }

  if (streamJson) {
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }
  }

  args.push('-p', prompt);
  return args;
}

class ClaudeCliRuntime extends AgentEventEmitterRuntime {
  #runningSessions = new Map<string, ClaudeRunningSession>();
  #projectPathProcesses = new ClaudeProjectPathProcessTracker();
  #pendingPermissions = new Map<string, PendingPermission>();
  #controlBroker: ClaudeControlBroker;
  #idlePurger: IdleSessionPurger<ClaudeRunningSession>;
  #shuttingDown = false;
  readonly #dependencies: ClaudeCliDependencies;

  constructor(dependencies: ClaudeCliDependencies = defaultClaudeCliDependencies()) {
    super();
    this.#dependencies = dependencies;
    this.#controlBroker = new ClaudeControlBroker(
      (agentSessionId, jsonl) => this.#writeToCLI(agentSessionId, jsonl),
    );
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
    eventMetadata: ReturnType<typeof claudeEventMetadata>,
  ): ClaudeActiveTurn {
    if (session.activeTurn) {
      throw new Error(`Claude session ${session.id} already has an active turn`);
    }
    let resolve: (() => void) | null = null;
    const completion = new Promise<void>((complete) => {
      resolve = complete;
    });
    const activeTurn: ClaudeActiveTurn = {
      protocol: new ClaudeTurnState(crypto.randomUUID()),
      eventMetadata,
      startedAt: Date.now(),
      completion,
      resolve,
      abortTimer: null,
      abortKilledProc: null,
    };
    session.activeTurn = activeTurn;
    session.lastActivityAt = activeTurn.startedAt;
    return activeTurn;
  }

  #writeToCLI(sessionId: string, jsonl: string): void {
    const session = this.#runningSessions.get(sessionId);
    if (!session?.process) throw new Error(`Claude session ${sessionId} has no writable process`);
    const stdin = session.process.stdin as import('bun').FileSink;
    if (!stdin?.write) throw new Error(`Claude session ${sessionId} has no writable stdin`);
    stdin.write(jsonl + '\n');
    stdin.flush();
  }

  #trySendToCLI(sessionId: string, jsonl: string): boolean {
    try {
      this.#writeToCLI(sessionId, jsonl);
      return true;
    } catch (err: unknown) {
      this.#dependencies.logger.warn('Claude CLI stdin write failed', {
        sessionId: sessionId.slice(0, 8),
        error: errorMessage(err),
      });
      return false;
    }
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
        turnId: activeTurn?.eventMetadata.turnId ?? null,
        sessionId: session.id.slice(0, 8),
        processId: session.process?.pid ?? null,
        inputId: activeTurn?.protocol.inputUuid.slice(0, 8) ?? null,
        source: inputEvent.source,
      });
    } else if (inputEvent?.type === 'terminal-before-start') {
      this.#handleInputTerminalBeforeStart(session, inputEvent.state);
      return;
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
            turnId: turn.eventMetadata.turnId ?? null,
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
          this.emitMessages(session.chatId, chatMessages, turn.eventMetadata);
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
    const activeTurn = session.activeTurn;
    if (msg.subtype === 'init') {
      this.#dependencies.logger.info('Claude CLI session initialized', {
        chatId: session.chatId,
        turnId: activeTurn?.eventMetadata.turnId ?? null,
        sessionId: session.id.slice(0, 8),
        processId: session.process?.pid ?? null,
        providerSessionId: msg.session_id ?? '',
        model: msg.model ?? '',
      });
      if (session.id !== msg.session_id) {
        this.#failSession(session, `Unexpected Claude session ID: ${msg.session_id || 'missing'}`);
        this.#killSessionProcess(session);
      }
      return;
    }

    if (msg.subtype === 'api_retry') {
      if (!activeTurn) return;
      const retry = activeTurn.protocol.recordApiRetry(msg);
      this.#dependencies.logger.warn('Claude API request is retrying', {
        chatId: session.chatId,
        turnId: activeTurn.eventMetadata.turnId ?? null,
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
      this.emitMessages(
        session.chatId,
        [new ErrorMessage(new Date().toISOString(), reason)],
        activeTurn.eventMetadata,
      );
      return;
    }

    if (msg.subtype === 'compact_boundary') {
      if (!activeTurn?.protocol.inputStarted) return;
      activeTurn.pendingCompaction = parseCompactMetadata(msg.compact_metadata);
    }
  }

  // Folds the post-compaction summary (delivered as a synthetic user message)
  // into a CompactionMessage, pairing it with the metadata from the preceding
  // compact_boundary. Ordinary user echoes carry no rendered output.
  #handleUserMessage(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn?.pendingCompaction) return;

    const content = msg.message?.content;
    const text = typeof content === 'string' ? content : '';
    if (!isCompactionSummaryText(text)) return;

    const pending = activeTurn.pendingCompaction;
    activeTurn.pendingCompaction = undefined;

    activeTurn.protocol.addOutputMessages(1);
    this.emitMessages(session.chatId, [
      new CompactionMessage(
        new Date().toISOString(),
        pending.trigger,
        extractCompactionSummary(text),
        pending.preTokens,
        pending.postTokens,
      ),
    ], activeTurn.eventMetadata);
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
      turnId: activeTurn.eventMetadata.turnId ?? null,
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

    if (
      msg.is_error
      && protocol.abortRequested
      && msg.terminal_reason === 'aborted_streaming'
    ) {
      this.#dependencies.logger.info('Claude CLI turn stopped after an interrupt', resultDetails);
      this.#finishTurn(session);
      return;
    }

    const resultText = typeof msg.result === 'string' ? msg.result.trim() : '';
    if (!msg.is_error && !protocol.assistantContentSeen && resultText) {
      protocol.addOutputMessages(1, true);
      this.emitMessages(
        session.chatId,
        [new AssistantMessage(new Date().toISOString(), resultText)],
        activeTurn.eventMetadata,
      );
    }
    const completedWithoutResponse = protocol.completedWithoutResponse(msg);
    if (msg.is_error || completedWithoutResponse) {
      this.#dependencies.logger.warn('Claude CLI turn completed with an error', resultDetails);
    } else {
      this.#dependencies.logger.info('Claude CLI turn completed', resultDetails);
    }
    if (msg.is_error) {
      this.#failSession(session, claudeResultFailureMessage(msg));
      return;
    }
    if (completedWithoutResponse) {
      this.#failSession(session, protocol.emptyCompletionFailureMessage());
      return;
    }
    this.#finishTurn(session);
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
      turnId: activeTurn.eventMetadata.turnId ?? null,
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

  #emitPermissionMessages(
    chatId: string,
    messages: ChatMessage[],
    eventMetadata?: RuntimeEventMetadata,
  ): void {
    if (!messages.length) return;
    this.emitMessages(chatId, messages, eventMetadata);
  }

  #handleControlRequest(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    const request = msg.request;
    const subtype = request?.subtype;
    if (!request || subtype !== 'can_use_tool') {
      this.#trySendToCLI(session.id, JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: msg.request_id,
          error: `Unsupported control request subtype: ${subtype || 'missing'}`,
        },
      }));
      return;
    }
    const activeTurn = session.activeTurn;
    if (!activeTurn?.protocol.inputStarted) {
      this.#trySendToCLI(session.id, JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: msg.request_id,
          error: 'Claude tool permission arrived outside the active Garcon turn',
        },
      }));
      return;
    }

    const permissionRequestId = `claude-${crypto.randomBytes(8).toString('hex')}`;
    const toolName = request.tool_name || 'Unknown';
    const toolInput = request.input || {};
    const toolUseId = request.tool_use_id;

    if (isManualBypassMode(session.currentPermissionMode) && !isClaudeAskUserQuestionTool(toolName)) {
      const response = buildClaudePermissionApprovalResponse(
        { toolName, toolInput, toolUseId },
        { allow: true, alwaysAllow: false },
      );
      this.#trySendToCLI(session.id, JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response,
        },
      }));
      return;
    }

    this.#pendingPermissions.set(permissionRequestId, {
      cliRequestId: msg.request_id!,
      agentSessionId: session.id,
      chatId: session.chatId,
      toolName,
      toolInput,
      toolUseId,
      eventMetadata: activeTurn.eventMetadata,
    });

    const now = new Date().toISOString();
    this.#emitPermissionMessages(session.chatId, [
      new PermissionRequestMessage(
        now,
        permissionRequestId,
        convertClaudePermissionTool(now, toolUseId ?? permissionRequestId, toolName, request.input),
      ),
    ], activeTurn.eventMetadata);
  }

  #handleControlCancelRequest(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    if (!msg.request_id) return;
    for (const [permissionRequestId, pending] of this.#pendingPermissions) {
      if (pending.agentSessionId !== session.id || pending.cliRequestId !== msg.request_id) continue;
      this.#pendingPermissions.delete(permissionRequestId);
      this.#emitPermissionMessages(
        pending.chatId,
        [new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, 'cancelled')],
        pending.eventMetadata,
      );
      return;
    }
  }

  #handleControlResponse(session: ClaudeRunningSession, msg: ClaudeCLIMessage): void {
    this.#controlBroker.handleResponse(session.id, msg);
  }

  #killSessionProcess(session: ClaudeRunningSession): void {
    this.#clearAbortTimer(session);
    this.#controlBroker.rejectSession(session.id, 'Claude CLI process was retired');
    const proc = session.process;
    if (!proc) return;
    session.process = null;
    this.#projectPathProcesses.trackDetached(session.id, session.chatId, proc);
    if (!proc.killed) {
      proc.kill();
    }
  }

  #retireSession(session: ClaudeRunningSession): void {
    const activeTurn = session.activeTurn;
    this.#killSessionProcess(session);
    session.activeTurn = null;
    if (activeTurn) this.emitProcessing(session.chatId, false);
    activeTurn?.resolve?.();
    if (activeTurn) activeTurn.resolve = null;
    this.#completeSessionInitialization(session);

    for (const [permissionRequestId, pending] of this.#pendingPermissions) {
      if (pending.agentSessionId !== session.id) continue;
      this.#emitPermissionMessages(pending.chatId, [
        new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, 'cancelled'),
      ], pending.eventMetadata);
      this.#pendingPermissions.delete(permissionRequestId);
    }
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
    this.#clearAbortTimer(session);
    session.activeTurn = null;
    this.#controlBroker.rejectSession(session.id, 'Claude turn settled', 'interrupt');
    session.lastActivityAt = Date.now();
    this.emitProcessing(session.chatId, false);
    this.emitFailed(session.chatId, message, activeTurn.eventMetadata);
    activeTurn.resolve?.();
    activeTurn.resolve = null;
  }

  #finishTurn(session: ClaudeRunningSession): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn) return;
    this.#clearAbortTimer(session);
    session.activeTurn = null;
    this.#controlBroker.rejectSession(session.id, 'Claude turn settled', 'interrupt');
    session.lastActivityAt = Date.now();
    this.emitProcessing(session.chatId, false);
    this.emitFinished(session.chatId, 0, activeTurn.eventMetadata);
    activeTurn.resolve?.();
    activeTurn.resolve = null;
  }

  #evictIdleSession(id: string, session: ClaudeRunningSession): void {
    this.#killSessionProcess(session);
    this.#runningSessions.delete(id);
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
    for (const pending of this.#pendingPermissions.values()) {
      if (pending.agentSessionId === agentSessionId) {
        throw new Error('Cannot update project path while Claude is waiting for permission');
      }
    }

    if (session) this.#clearAbortTimer(session);
    await this.#projectPathProcesses.stopForUpdate({
      agentSessionId,
      chatId: request.chatId,
      activeProcess: session?.process ?? null,
    });
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
      this.#killSessionProcess(session);
    }
  }

  setInternalClaudeThinkingMode(agentSessionId: string, mode: ClaudeThinkingMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.options = { ...session.options, claudeThinkingMode: mode };

    if (session.process && !session.activeTurn) {
      this.#killSessionProcess(session);
    }
  }

  resolveInternalToolApproval(permissionRequestId: string, decision: PermissionDecisionPayload): void {
    const pending = this.#pendingPermissions.get(permissionRequestId);
    if (!pending) {
      this.#dependencies.logger.warn('Claude permission response has no pending request', {
        permissionRequestId,
      });
      return;
    }
    this.#pendingPermissions.delete(permissionRequestId);

    const response = buildClaudePermissionApprovalResponse(pending, decision);

    this.#trySendToCLI(pending.agentSessionId, JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: pending.cliRequestId,
        response,
      },
    }));

    this.#emitPermissionMessages(
      pending.chatId,
      [new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, Boolean(decision.allow))],
      pending.eventMetadata,
    );
  }

  #sendUserMessage(
    session: ClaudeRunningSession,
    activeTurn: ClaudeActiveTurn,
    command: string,
    images?: readonly AgentAttachment[],
  ): void {
    const prompt = appendTextAttachmentContext(command, images);
    const imageParts = imageAttachments(images);
    const documentParts = documentAttachments(images);
    let content: unknown;
    if (imageParts.length || documentParts.length) {
      const blocks: unknown[] = [];
      for (const img of imageParts) {
        const parts = parseAttachmentDataUrl(img.data);
        if (parts) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: parts.mimeType, data: parts.base64 },
          });
        }
      }
      for (const doc of documentParts) {
        const block = attachmentDocumentBlock(doc);
        if (block) blocks.push(block);
      }
      blocks.push({ type: 'text', text: prompt });
      content = blocks;
    } else {
      content = prompt;
    }

    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.id || '',
      uuid: activeTurn.protocol.inputUuid,
    });

    this.#writeToCLI(session.id, jsonl);
  }

  #waitForTurnComplete(activeTurn: ClaudeActiveTurn): Promise<void> {
    return activeTurn.completion;
  }

  #buildCLIArgs(session: ClaudeRunningSession, options: ClaudeSessionOptions, resume: boolean, supportsLegacyThinkingFlag: boolean): string[] {
    return buildClaudeCLIArgs({
      model: options.model,
      permissionMode: options.permissionMode,
      thinkingMode: options.thinkingMode,
      claudeThinkingMode: options.claudeThinkingMode,
      prompt: '',
      streamJson: true,
      sessionId: resume ? undefined : session.id,
      resumeSessionId: resume ? session.id : undefined,
      supportsLegacyThinkingFlag,
    });
  }

  #handleProcessExit(session: ClaudeRunningSession, proc: ReturnType<typeof Bun.spawn>, exitCode: number): void {
    if (session.process !== proc) {
      return;
    }

    session.process = null;
    session.lastActivityAt = Date.now();
    this.#clearAbortTimer(session);
    this.#controlBroker.rejectSession(session.id, `Claude CLI process exited with code ${exitCode}`);
    const activeTurn = session.activeTurn;
    const wasAbortKill = activeTurn?.abortKilledProc === proc;
    if (activeTurn) activeTurn.abortKilledProc = null;

    for (const [permissionRequestId, pending] of this.#pendingPermissions) {
      if (pending.agentSessionId === session.id) {
        this.#emitPermissionMessages(
          pending.chatId,
          [new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, 'cancelled')],
          pending.eventMetadata,
        );
        this.#pendingPermissions.delete(permissionRequestId);
      }
    }

    if (activeTurn) {
      if (wasAbortKill && activeTurn.protocol.inputStarted) {
        this.#finishTurn(session);
      } else if (wasAbortKill) {
        this.#failSession(
          session,
          'Claude CLI exited before confirming cancellation of the queued message.',
        );
      } else {
        this.#failSession(session, `CLI process exited with code ${exitCode}`);
      }
    }
  }

  // Stays synchronous so callers can check process liveness and spawn without
  // an interleaving await; the legacy-flag probe is resolved by callers first.
  #spawnCLI(session: ClaudeRunningSession, options: ClaudeSessionOptions, resume: boolean, supportsLegacyThinkingFlag: boolean): ReturnType<typeof Bun.spawn> {
    const claudeBinary = this.#dependencies.binary();
    const args = this.#buildCLIArgs(session, options, resume, supportsLegacyThinkingFlag);

    this.#dependencies.logger.info('Spawning Claude CLI', {
      binary: claudeBinary,
      arguments: args,
    });

    const proc = Bun.spawn([claudeBinary, ...args], {
      cwd: options.projectPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: (() => { const { CLAUDECODE, ...env } = process.env; return { ...env, ...options.envOverrides }; })(),
    });

    session.options = options;
    session.process = proc;
    session.currentThinkingMode = options.thinkingMode || 'none';
    session.currentClaudeThinkingMode = normalizeClaudeThinkingModeForState(options.claudeThinkingMode);
    session.currentModel = options.model || '';
    session.currentEnvOverrides = options.envOverrides;
    pipeClaudeProcessOutput<ClaudeCLIMessage>({
      process: proc,
      logger: this.#dependencies.logger,
      sessionId: session.id,
      onMessage: msg => this.#routeCLIMessage(session, proc, msg),
    });

    proc.exited.then((exitCode: number) => {
      const exitedDuringTurn = session.process === proc
        && session.activeTurn !== null
        && session.activeTurn.abortKilledProc !== proc;
      const activeTurn = session.activeTurn;
      const details = {
        chatId: session.chatId,
        turnId: activeTurn?.eventMetadata.turnId ?? null,
        sessionId: session.id.slice(0, 8),
        processId: proc.pid ?? null,
        exitCode,
        duringTurn: exitedDuringTurn,
      };
      if (exitedDuringTurn) {
        this.#dependencies.logger.error('Claude CLI process exited during an active turn', details);
      } else {
        this.#dependencies.logger.info('Claude CLI process exited', details);
      }
      this.#handleProcessExit(session, proc, exitCode);
    });

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
      onAbortable,
      clientRequestId,
      turnId,
      executionAdmission,
    } = request;
    const requestAdmission = { executionAdmission };
    if (!chatId) throw new Error('chatId is required when starting a Claude session');
    if (!agentSessionId) throw new Error('agentSessionId is required when starting a Claude session');

    const allOpts: ClaudeSessionOptions = {
      agentSessionId,
      sessionId: agentSessionId,
      chatId,
      images,
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
      activeTurn: null,
      process: null,
      options: allOpts,
      currentPermissionMode: permissionMode || 'default',
      currentThinkingMode: thinkingMode || 'none',
      currentClaudeThinkingMode: normalizeClaudeThinkingModeForState(claudeThinkingMode),
      currentModel: model || '',
      currentEnvOverrides: envOverrides,
    };
    const activeTurn = this.#beginTurn(
      session,
      claudeEventMetadata({ clientRequestId, turnId }, 'chat-start'),
    );

    const previous = this.#runningSessions.get(agentSessionId);
    if (previous) this.#retireSession(previous);
    this.#runningSessions.set(agentSessionId, session);

    let supportsLegacyThinkingFlag: boolean;
    try {
      supportsLegacyThinkingFlag = await this.#dependencies.versionProbe
        .supportsLegacyThinkingFlag(this.#dependencies.binary());
    } catch (error) {
      if (this.#runningSessions.get(agentSessionId) === session) {
        session.activeTurn = null;
        activeTurn.resolve?.();
        activeTurn.resolve = null;
        this.#runningSessions.delete(agentSessionId);
      }
      this.#completeSessionInitialization(session);
      throw error;
    }
    // Another start may supersede this one while the version probe is pending.
    if (this.#runningSessions.get(agentSessionId) !== session) return agentSessionId;

    try {
      assertClaudeExecutionOpen(requestAdmission);
      this.emitSessionCreated(chatId);
      this.#spawnCLI(session, allOpts, false, supportsLegacyThinkingFlag);
      assertClaudeExecutionOpen(requestAdmission);
      this.#sendUserMessage(session, activeTurn, command, images);
      executionAdmission?.markStarted();
      this.emitProcessing(chatId, true);
      onAbortable?.();
      this.#completeSessionInitialization(session);
      await this.#waitForTurnComplete(activeTurn);
    } catch (error) {
      if (this.#runningSessions.get(agentSessionId) === session) {
        this.#retireSession(session);
        this.#runningSessions.delete(agentSessionId);
      }
      throw error;
    } finally {
      this.#completeSessionInitialization(session);
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
      onAbortable,
      clientRequestId,
      turnId,
      executionAdmission,
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
    const supportsLegacyThinkingFlag = await this.#dependencies.versionProbe
      .supportsLegacyThinkingFlag(this.#dependencies.binary());
    assertClaudeExecutionOpen(requestAdmission);
    if (this.#shuttingDown) throw new Error('Claude runtime is shutting down');

    const allOpts: ClaudeSessionOptions = {
      agentSessionId,
      sessionId: agentSessionId,
      chatId,
      images,
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
        activeTurn: null,
        process: null,
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
    if (session.activeTurn) {
      throw new Error(`Claude session ${agentSessionId} already has an active turn`);
    }

    try {
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }

      session.options = mergeClaudeSessionOptions(session.options, allOpts);

    const effectiveChatId = chatId || session.chatId;
    session.chatId = effectiveChatId;
    session.lastActivityAt = Date.now();
    const desiredThinkingMode = session.options.thinkingMode || 'none';
    const desiredClaudeThinkingMode = normalizeClaudeThinkingModeForState(session.options.claudeThinkingMode);
    const desiredModel = session.options.model || '';
    const desiredPermissionMode = session.options.permissionMode || 'default';
    const previousProviderPermissionMode = session.process
      ? providerStartupPermissionMode(session.currentPermissionMode)
      : 'default';
    const desiredProviderPermissionMode = providerStartupPermissionMode(desiredPermissionMode);
    const permissionStartupChanged = previousProviderPermissionMode !== desiredProviderPermissionMode
      && (previousProviderPermissionMode === 'bypassPermissions' || desiredProviderPermissionMode === 'bypassPermissions');
    const previousModel = session.process ? (session.currentModel || '') : '';
    const envChanged = this.#envOverridesChanged(session.currentEnvOverrides, session.options.envOverrides);
    if (session.process && (
      desiredThinkingMode !== session.currentThinkingMode
      || desiredClaudeThinkingMode !== session.currentClaudeThinkingMode
      || desiredModel !== previousModel
      || permissionStartupChanged
      || envChanged
    )) {
      this.#killSessionProcess(session);
    }

    if (!session.process) {
      const spawnOpts: ClaudeSessionOptions = {
        agentSessionId,
        sessionId: agentSessionId,
        chatId: effectiveChatId,
        images: allOpts.images ?? session.options?.images,
        model: allOpts.model ?? session.options?.model,
        permissionMode: allOpts.permissionMode ?? session.options?.permissionMode,
        projectPath: allOpts.projectPath ?? session.options?.projectPath,
        thinkingMode: allOpts.thinkingMode ?? session.options?.thinkingMode,
        claudeThinkingMode: allOpts.claudeThinkingMode ?? session.options?.claudeThinkingMode,
        envOverrides: allOpts.envOverrides ?? session.options?.envOverrides,
      };
      // Always resume: the session file preserves conversation context.
      // Cross-boundary local/cloud switches are blocked by
      // AgentRegistry.runAgentTurn before reaching here.
      assertClaudeExecutionOpen(requestAdmission);
      this.#spawnCLI(session, spawnOpts, true, supportsLegacyThinkingFlag);
    }

    const newMode = desiredPermissionMode;
    if (session.currentPermissionMode && newMode !== session.currentPermissionMode) {
      this.setInternalPermissionMode(agentSessionId, newMode);
    }
    session.currentPermissionMode = newMode;

    // A new turn supersedes any prior abort, so cancel its force-kill fallback
    // before it can fire against the process now serving this turn.
    this.#clearAbortTimer(session);
    assertClaudeExecutionOpen(requestAdmission);
    const activeTurn = this.#beginTurn(
      session,
      claudeEventMetadata({ clientRequestId, turnId }),
    );
    this.#sendUserMessage(session, activeTurn, command, images);
    executionAdmission?.markStarted();
    this.emitProcessing(effectiveChatId, true);
    onAbortable?.();
      await this.#waitForTurnComplete(activeTurn);
    } catch (error) {
      if (session.activeTurn) {
        this.#retireSession(session);
      }
      throw error;
    }
  }

  #handleInterruptReceipt(
    session: ClaudeRunningSession,
    activeTurn: ClaudeActiveTurn,
    value: unknown,
  ): void {
    if (session.activeTurn !== activeTurn) return;
    const receipt = isRecord(value) ? value : {};
    const cancelled = Array.isArray(receipt.cancelled)
      ? receipt.cancelled.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const stillQueued = Array.isArray(receipt.still_queued)
      ? receipt.still_queued.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const inputUuid = activeTurn.protocol.inputUuid;
    const details = {
      chatId: session.chatId,
      turnId: activeTurn.eventMetadata.turnId ?? null,
      sessionId: session.id.slice(0, 8),
      processId: session.process?.pid ?? null,
      inputId: inputUuid.slice(0, 8),
      cancelledCount: cancelled.length,
      stillQueuedCount: stillQueued.length,
    };

    if (!activeTurn.protocol.inputStarted && cancelled.includes(inputUuid)) {
      this.#dependencies.logger.info('Claude CLI confirmed queued input cancellation', details);
      this.#finishTurn(session);
      return;
    }
    if (stillQueued.includes(inputUuid)) {
      this.#dependencies.logger.warn('Claude CLI interrupt left the submitted input queued', details);
      return;
    }
    this.#dependencies.logger.debug('Claude CLI acknowledged interrupt', details);
  }

  async abortClaudeInternalSession(agentSessionId: string): Promise<boolean> {
    const session = this.#runningSessions.get(agentSessionId);
    const activeTurn = session?.activeTurn;
    if (!session?.process || !activeTurn) return false;

    activeTurn.protocol.markAbortRequested();
    let receipt: Promise<unknown>;
    try {
      receipt = this.#controlBroker.request(session.id, {
        subtype: 'interrupt',
        cancel_queued: true,
      });
    } catch {
      this.#failSession(session, 'Failed to send interrupt to Claude CLI.');
      this.#killSessionProcess(session);
      return false;
    }
    void receipt.then(
      (value) => this.#handleInterruptReceipt(session, activeTurn, value),
      (error: unknown) => {
        if (session.activeTurn !== activeTurn) return;
        this.#dependencies.logger.warn('Claude CLI interrupt request failed', {
          sessionId: agentSessionId.slice(0, 8),
          inputId: activeTurn.protocol.inputUuid.slice(0, 8),
          error: errorMessage(error),
        });
      },
    );

    const proc = session.process;
    this.#clearAbortTimer(session);
    activeTurn.abortTimer = setTimeout(() => {
      activeTurn.abortTimer = null;
      // Only fires when the interrupt was never acknowledged: the same process
      // is still stuck on the aborted turn. An acknowledged interrupt or a new
      // turn clears this timer first, so a reused process is never killed here.
      if (session.process === proc && !proc.killed) {
        this.#dependencies.logger.warn('Claude CLI interrupt was not acknowledged', {
          sessionId: agentSessionId.slice(0, 8),
        });
        activeTurn.abortKilledProc = proc;
        proc.kill();
      }
    }, 5000);

    return true;
  }

  failClaudeInternalSession(
    agentSessionId: string,
    chatId: string,
    errorMessage: string,
    eventMetadata: RuntimeEventMetadata,
  ): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (session) {
      this.#failSession(session, errorMessage);
      this.#killSessionProcess(session);
      return;
    }
    this.emitProcessing(chatId, false);
    this.emitFailed(chatId, errorMessage, eventMetadata);
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

  shutdown(): void {
    this.#shuttingDown = true;
    this.#idlePurger.stop();
    for (const session of this.#runningSessions.values()) {
      this.#clearAbortTimer(session);
      this.#controlBroker.rejectSession(session.id, 'Claude runtime shut down');
      if (session.process && !session.process.killed) {
        session.process.kill();
      }
      const activeTurn = session.activeTurn;
      session.activeTurn = null;
      if (activeTurn) {
        this.emitProcessing(session.chatId, false);
      }
      activeTurn?.resolve?.();
      if (activeTurn) activeTurn.resolve = null;
      this.#completeSessionInitialization(session);
    }
    this.#runningSessions.clear();
    this.#pendingPermissions.clear();
    this.#controlBroker.shutdown('Claude runtime shut down');
  }
}

function defaultClaudeCliDependencies(): ClaudeCliDependencies {
  return {
    binary: () => 'claude',
    logger: NOOP_LOGGER,
    versionProbe: new ClaudeCliVersionProbe(NOOP_LOGGER),
  };
}

export { ClaudeCliRuntime, buildClaudeCLIArgs, buildClaudePermissionApprovalResponse, convertCLIMessageToChatMessages, runSingleQuery };
