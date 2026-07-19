// Claude CLI transport. Spawns the `claude` binary with stdin/stdout
// pipes, exchanging JSONL messages. Extends AgentEventEmitterRuntime so all output
// flows through typed events wired in the composition root.

import crypto from 'crypto';
import { normalizeToolResultContent }  from '@garcon/server-agent-common/shared/normalize-util';
import { AssistantMessage, ThinkingMessage, ToolResultMessage, PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage, CompactionMessage, ErrorMessage } from '@garcon/common/chat-types';
import type { ChatMessage, CompactionTrigger } from '@garcon/common/chat-types';
import type { AskUserQuestionDecisionResponse, PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { extractCompactionSummary, isCompactionSummaryText, parseCompactMetadata } from "./compaction.js";
import { convertClaudePermissionTool } from "./permission-tool-converter.js";
import { convertClaudeToolUse } from "./tool-use-converter.js";
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
import { isManualBypassMode, providerStartupPermissionMode } from '@garcon/server-agent-common/execution/permission-modes';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';

const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface CompactMetadata {
  trigger?: string;
  pre_tokens?: number;
  post_tokens?: number;
}

interface CLIMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  content?: unknown[];
  message?: { role?: string; content?: unknown };
  request_id?: string;
  status?: string | null;
  compact_result?: string;
  compact_error?: string;
  compact_metadata?: CompactMetadata;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
  };
  response?: {
    subtype?: string;
    request_id?: string;
    error?: string;
    response?: unknown;
  };
}

interface ClaudeContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

function isClaudeContentPart(value: unknown): value is ClaudeContentPart {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  isRunning: boolean;
  turnResolve: ((value: void | PromiseLike<void>) => void) | null;
  initialization: Promise<void> | null;
  completeInitialization: (() => void) | null;
  turnLocked: boolean;
  turnWaiters: Array<() => void>;
  startTime: number;
  lastActivityAt: number;
  process: ReturnType<typeof Bun.spawn> | null;
  // Fallback timer that force-kills the process if an interrupt is never
  // acknowledged. Cleared once the turn resolves, the process exits, or a new
  // turn reuses the persistent process, so it never kills a live follow-up turn.
  abortTimer: ReturnType<typeof setTimeout> | null;
  // Set to the process the abort fallback force-killed. Its exit is the intended
  // outcome of a user interrupt, so it surfaces as a clean stop rather than a
  // "CLI process exited with code 143" error. Only the fallback sets this, so an
  // unrelated crash during the abort window is still reported as a failure.
  abortKilledProc: ReturnType<typeof Bun.spawn> | null;
  options: ClaudeSessionOptions;
  currentPermissionMode: PermissionMode;
  currentThinkingMode: ThinkingMode;
  currentClaudeThinkingMode: ClaudeThinkingMode;
  currentModel: string;
  currentEnvOverrides?: Record<string, string>;
  // Set when a `compact_boundary` arrives, consumed by the summary user message
  // that follows it so both can be emitted as a single CompactionMessage.
  pendingCompaction?: { trigger: CompactionTrigger; preTokens?: number; postTokens?: number };
  eventMetadata: ReturnType<typeof claudeEventMetadata>;
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

interface PendingControlRequest {
  resolve: (value: unknown) => void;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

// Converts a finalized CLI assistant message to ChatMessage objects.
function convertCLIMessageToChatMessages(msg: CLIMessage): ChatMessage[] {
  if (msg.type !== 'assistant') return [];

  const chatMessages: ChatMessage[] = [];
  const now = new Date().toISOString();
  const rawContent =
    Array.isArray(msg.content) ? msg.content
      : Array.isArray(msg.message?.content) ? msg.message!.content!
        : [];
  const content = rawContent.filter(isClaudeContentPart);

  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      chatMessages.push(new AssistantMessage(now, part.text));
    }
    if (part.type === 'thinking' && part.thinking) {
      chatMessages.push(new ThinkingMessage(now, part.thinking));
    }
    if (part.type === 'tool_use') {
      chatMessages.push(convertClaudeToolUse(now, part));
    }
    if (part.type === 'tool_result') {
      chatMessages.push(new ToolResultMessage(now, part.tool_use_id || '', normalizeToolResultContent(part.content), Boolean(part.is_error)));
    }
  }

  return chatMessages;
}

// Runs a one-shot CLI query and returns the plain text output.
async function runSingleQuery(
  prompt: string,
  { model, cwd, permissionMode, thinkingMode, claudeThinkingMode, envOverrides }: ClaudeSingleQueryOptions = {},
  dependencies: ClaudeCliDependencies = defaultClaudeCliDependencies(),
): Promise<string> {
  const claudeBinary = dependencies.binary();
  const supportsLegacyThinkingFlag = await dependencies.versionProbe.supportsLegacyThinkingFlag(claudeBinary);
  const args = buildClaudeCLIArgs({ model, permissionMode, thinkingMode, claudeThinkingMode, prompt, supportsLegacyThinkingFlag });

  const proc = Bun.spawn([claudeBinary, ...args], {
    cwd: cwd || process.cwd(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: (() => { const { CLAUDECODE, ...env } = process.env; return { ...env, ...envOverrides }; })(),
  });

  const chunks: Uint8Array[] = [];
  const reader = proc.stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (err: unknown) {
    dependencies.logger.error('Claude one-shot stdout read failed', {
      error: errorMessage(err),
    });
  }

  await proc.exited;

  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
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
    ? ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']
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
  #pendingPermissions = new Map<string, PendingPermission>();
  #pendingControlRequests = new Map<string, PendingControlRequest>();
  #idlePurger: IdleSessionPurger<ClaudeRunningSession>;
  #shuttingDown = false;
  readonly #dependencies: ClaudeCliDependencies;

  constructor(dependencies: ClaudeCliDependencies = defaultClaudeCliDependencies()) {
    super();
    this.#dependencies = dependencies;
    this.#idlePurger = new IdleSessionPurger({
      sessions: () => this.#runningSessions.entries(),
      isRunning: (session) => session.isRunning,
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
    msg: CLIMessage,
  ): void {
    if (this.#runningSessions.get(session.id) !== session || session.process !== proc) return;

    switch (msg.type) {
      case 'system':
        this.#handleSystemMessage(session, msg);
        break;

      case 'assistant': {
        if (!session.isRunning) return;
        const chatMessages = convertCLIMessageToChatMessages(msg);
        if (chatMessages.length > 0) {
          this.emitMessages(session.chatId, chatMessages, session.eventMetadata);
        }
        break;
      }

      case 'stream_event':
        break;

      case 'result':
        if (!session.isRunning) return;
        this.#handleResultMessage(session, msg);
        break;

      case 'control_request':
        if (!session.isRunning) return;
        this.#handleControlRequest(session, msg);
        break;

      case 'control_response':
        this.#handleControlResponse(session, msg);
        break;

      case 'user':
        if (!session.isRunning) return;
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

  #handleSystemMessage(session: ClaudeRunningSession, msg: CLIMessage): void {
    if (msg.subtype === 'init') {
      this.#dependencies.logger.info('Claude CLI session initialized', {
        sessionId: session.id.slice(0, 8),
        providerSessionId: msg.session_id ?? '',
        model: msg.model ?? '',
      });
      if (session.id !== msg.session_id) {
        this.#failSession(session, `Unexpected Claude session ID: ${msg.session_id || 'missing'}`);
        this.#killSessionProcess(session);
      }
      return;
    }

    if (msg.subtype === 'status' && msg.compact_result === 'failed') {
      if (!session.isRunning) return;
      session.pendingCompaction = undefined;
      const reason = msg.compact_error || 'Compaction failed';
      this.emitMessages(
        session.chatId,
        [new ErrorMessage(new Date().toISOString(), reason)],
        session.eventMetadata,
      );
      return;
    }

    if (msg.subtype === 'compact_boundary') {
      if (!session.isRunning) return;
      session.pendingCompaction = parseCompactMetadata(msg.compact_metadata);
    }
  }

  // Folds the post-compaction summary (delivered as a synthetic user message)
  // into a CompactionMessage, pairing it with the metadata from the preceding
  // compact_boundary. Ordinary user echoes carry no rendered output.
  #handleUserMessage(session: ClaudeRunningSession, msg: CLIMessage): void {
    if (!session.pendingCompaction) return;

    const content = msg.message?.content;
    const text = typeof content === 'string' ? content : '';
    if (!isCompactionSummaryText(text)) return;

    const pending = session.pendingCompaction;
    session.pendingCompaction = undefined;

    this.emitMessages(session.chatId, [
      new CompactionMessage(
        new Date().toISOString(),
        pending.trigger,
        extractCompactionSummary(text),
        pending.preTokens,
        pending.postTokens,
      ),
    ], session.eventMetadata);
  }

  // Cancels the pending force-kill fallback armed by an abort. Safe to call
  // when none is armed.
  #clearAbortTimer(session: ClaudeRunningSession): void {
    if (session.abortTimer) {
      clearTimeout(session.abortTimer);
      session.abortTimer = null;
    }
  }

  #handleResultMessage(session: ClaudeRunningSession, msg: CLIMessage): void {
    // The turn has ended (including an acknowledged interrupt), so the abort
    // fallback must not fire against the still-alive persistent process.
    this.#clearAbortTimer(session);
    session.isRunning = false;
    session.lastActivityAt = Date.now();
    this.emitProcessing(session.chatId, false);
    this.emitFinished(session.chatId, msg.is_error ? 1 : 0, session.eventMetadata);
    if (session.turnResolve) {
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve();
    }
  }

  #emitPermissionMessages(
    chatId: string,
    messages: ChatMessage[],
    eventMetadata?: RuntimeEventMetadata,
  ): void {
    if (!messages.length) return;
    this.emitMessages(chatId, messages, eventMetadata);
  }

  #handleControlRequest(session: ClaudeRunningSession, msg: CLIMessage): void {
    if (msg.request?.subtype !== 'can_use_tool') return;

    const permissionRequestId = `claude-${crypto.randomBytes(8).toString('hex')}`;
    const toolName = msg.request.tool_name || 'Unknown';
    const toolInput = msg.request.input || {};
    const toolUseId = msg.request.tool_use_id;

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
      eventMetadata: session.eventMetadata,
    });

    const now = new Date().toISOString();
    this.#emitPermissionMessages(session.chatId, [
      new PermissionRequestMessage(
        now,
        permissionRequestId,
        convertClaudePermissionTool(now, toolUseId ?? permissionRequestId, toolName, msg.request.input),
      ),
    ], session.eventMetadata);
  }

  #handleControlResponse(session: ClaudeRunningSession, msg: CLIMessage): void {
    const reqId = msg.response?.request_id;
    if (!reqId) return;
    const pending = this.#pendingControlRequests.get(reqId);
    if (!pending) return;
    this.#pendingControlRequests.delete(reqId);

    if (msg.response!.subtype === 'error') {
      this.#dependencies.logger.warn('Claude CLI control request failed', {
        error: msg.response!.error ?? '',
      });
      return;
    }
    pending.resolve(msg.response!.response ?? {});
  }

  #killSessionProcess(session: ClaudeRunningSession): void {
    this.#clearAbortTimer(session);
    const proc = session.process;
    if (!proc) return;
    session.process = null;
    if (!proc.killed) {
      proc.kill();
    }
  }

  #retireSession(session: ClaudeRunningSession): void {
    const wasRunning = session.isRunning;
    this.#killSessionProcess(session);
    session.isRunning = false;
    const resolve = session.turnResolve;
    session.turnResolve = null;
    if (wasRunning) this.emitProcessing(session.chatId, false);
    resolve?.();
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

  async #acquireTurn(session: ClaudeRunningSession): Promise<void> {
    if (!session.turnLocked) {
      session.turnLocked = true;
      return;
    }
    await new Promise<void>((resolve) => session.turnWaiters.push(resolve));
  }

  #releaseTurn(session: ClaudeRunningSession): void {
    const next = session.turnWaiters.shift();
    if (next) {
      next();
    } else {
      session.turnLocked = false;
    }
  }

  #failSession(session: ClaudeRunningSession, message: string): void {
    session.isRunning = false;
    session.lastActivityAt = Date.now();
    const resolve = session.turnResolve;
    session.turnResolve = null;
    this.emitProcessing(session.chatId, false);
    this.emitFailed(session.chatId, message, session.eventMetadata);
    resolve?.();
  }

  #evictIdleSession(id: string, session: ClaudeRunningSession): void {
    this.#killSessionProcess(session);
    this.#runningSessions.delete(id);
  }

  async prepareClaudeProjectPathUpdate(request: ClaudeProjectPathUpdate): Promise<void> {
    const agentSessionId = request.agentSessionId;
    if (!agentSessionId) return;

    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;
    if (session.chatId !== request.chatId) {
      throw new Error('Chat ID mismatch');
    }
    if (session.isRunning) {
      throw new Error('Cannot update project path while Claude is running');
    }
    for (const pending of this.#pendingPermissions.values()) {
      if (pending.agentSessionId === agentSessionId) {
        throw new Error('Cannot update project path while Claude is waiting for permission');
      }
    }

    session.options = { ...session.options, projectPath: request.nextProjectPath };
    if (session.process) {
      this.#killSessionProcess(session);
    }
  }

  setInternalPermissionMode(agentSessionId: string, mode: PermissionMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.currentPermissionMode = mode;
    session.options = { ...session.options, permissionMode: mode };

    if (session.process) {
      const requestId = crypto.randomUUID();
      const providerMode = providerStartupPermissionMode(mode);
      this.#trySendToCLI(agentSessionId, JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_permission_mode', mode: providerMode },
      }));
    }
  }

  setInternalThinkingMode(agentSessionId: string, mode: ThinkingMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.options = { ...session.options, thinkingMode: mode };

    if (session.process && !session.isRunning) {
      this.#killSessionProcess(session);
    }
  }

  setInternalClaudeThinkingMode(agentSessionId: string, mode: ClaudeThinkingMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.options = { ...session.options, claudeThinkingMode: mode };

    if (session.process && !session.isRunning) {
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

  #sendUserMessage(session: ClaudeRunningSession, command: string, images?: readonly AgentAttachment[]): void {
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
    });

    this.#writeToCLI(session.id, jsonl);
  }

  #waitForTurnComplete(session: ClaudeRunningSession): Promise<void> {
    if (!session.isRunning) return Promise.resolve();

    return new Promise<void>(resolve => {
      session.turnResolve = resolve;
    });
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

  async #readStdout(session: ClaudeRunningSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stdout || typeof proc.stdout === 'number') return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: CLIMessage;
          try {
            msg = JSON.parse(line);
          } catch {
            this.#dependencies.logger.warn('Claude CLI emitted invalid JSON', {
              sessionId: session.id.slice(0, 8),
            });
            continue;
          }
          this.#routeCLIMessage(session, proc, msg);
        }
      }
    } catch (err: unknown) {
      if (!proc.killed) {
        this.#dependencies.logger.error('Claude CLI stdout read failed', {
          sessionId: session.id.slice(0, 8),
          error: errorMessage(err),
        });
      }
    }
  }

  #handleProcessExit(session: ClaudeRunningSession, proc: ReturnType<typeof Bun.spawn>, exitCode: number): void {
    if (session.process !== proc) {
      return;
    }

    session.process = null;
    session.lastActivityAt = Date.now();
    this.#clearAbortTimer(session);
    // Whether this exit is the abort fallback's own force-kill (vs an unrelated
    // crash that merely happened during the abort window).
    const wasAbortKill = session.abortKilledProc === proc;
    session.abortKilledProc = null;

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

    if (session.turnResolve || session.isRunning) {
      const wasRunning = session.isRunning;
      session.isRunning = false;
      this.emitProcessing(session.chatId, false);
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve?.();
      if (wasRunning) {
        if (wasAbortKill) {
          // The exit is the intended result of a user interrupt whose CLI
          // acknowledgement never arrived: surface a clean stop, not an error.
          this.emitFinished(session.chatId, 0, session.eventMetadata);
        } else {
          this.emitFailed(
            session.chatId,
            `CLI process exited with code ${exitCode}`,
            session.eventMetadata,
          );
        }
      }
    }
  }

  async #pipeStderr(sessionId: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stderr || typeof proc.stderr === 'number') return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.trim()) {
            this.#dependencies.logger.info('Claude CLI stderr', {
              sessionId: sessionId.slice(0, 8),
              line,
            });
          }
        }
      }
    } catch { /* stream closed */ }
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
    this.#readStdout(session, proc);
    this.#pipeStderr(session.id, proc);

    proc.exited.then((exitCode: number) => {
      this.#dependencies.logger.info('Claude CLI process exited', {
        sessionId: session.id.slice(0, 8),
        exitCode,
      });
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
      isRunning: true,
      turnResolve: null,
      initialization,
      completeInitialization,
      turnLocked: false,
      turnWaiters: [],
      startTime: Date.now(),
      lastActivityAt: Date.now(),
      process: null,
      abortTimer: null,
      abortKilledProc: null,
      options: allOpts,
      currentPermissionMode: permissionMode || 'default',
      currentThinkingMode: thinkingMode || 'none',
      currentClaudeThinkingMode: normalizeClaudeThinkingModeForState(claudeThinkingMode),
      currentModel: model || '',
      currentEnvOverrides: envOverrides,
      eventMetadata: claudeEventMetadata({ clientRequestId, turnId }, 'chat-start'),
    };

    const previous = this.#runningSessions.get(agentSessionId);
    if (previous) this.#retireSession(previous);
    this.#runningSessions.set(agentSessionId, session);

    let supportsLegacyThinkingFlag: boolean;
    try {
      supportsLegacyThinkingFlag = await this.#dependencies.versionProbe
        .supportsLegacyThinkingFlag(this.#dependencies.binary());
    } catch (error) {
      if (this.#runningSessions.get(agentSessionId) === session) {
        session.isRunning = false;
        this.#runningSessions.delete(agentSessionId);
      }
      this.#completeSessionInitialization(session);
      throw error;
    }
    // Another start may supersede this one while the version probe is pending.
    if (this.#runningSessions.get(agentSessionId) !== session) return agentSessionId;

    let processingEmitted = false;
    try {
      assertClaudeExecutionOpen(requestAdmission);
      this.emitSessionCreated(chatId);
      this.#spawnCLI(session, allOpts, false, supportsLegacyThinkingFlag);
      assertClaudeExecutionOpen(requestAdmission);
      this.#sendUserMessage(session, command, images);
      executionAdmission?.markStarted();
      processingEmitted = true;
      this.emitProcessing(chatId, true);
      onAbortable?.();
      await this.#waitForTurnComplete(session);
    } catch (error) {
      if (this.#runningSessions.get(agentSessionId) === session) {
        if (!processingEmitted) session.isRunning = false;
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

    let session: ClaudeRunningSession;
    while (true) {
      let candidate = this.#runningSessions.get(agentSessionId);
      while (candidate?.initialization) {
        await candidate.initialization;
        candidate = this.#runningSessions.get(agentSessionId);
      }
      if (!candidate) {
        candidate = {
        id: agentSessionId,
        chatId: chatId,
        isRunning: false,
        turnResolve: null,
        initialization: null,
        completeInitialization: null,
        turnLocked: false,
        turnWaiters: [],
        startTime: Date.now(),
        lastActivityAt: Date.now(),
        process: null,
        abortTimer: null,
        abortKilledProc: null,
        options: allOpts,
        currentPermissionMode: permissionMode || 'default',
        currentThinkingMode: thinkingMode || 'none',
        currentClaudeThinkingMode: normalizeClaudeThinkingModeForState(claudeThinkingMode),
        currentModel: model || '',
        currentEnvOverrides: envOverrides,
        eventMetadata: claudeEventMetadata({ clientRequestId, turnId }),
        };
        this.#runningSessions.set(agentSessionId, candidate);
      }

      await this.#acquireTurn(candidate);
      if (this.#shuttingDown) {
        this.#releaseTurn(candidate);
        throw new Error('Claude runtime is shutting down');
      }
      if (this.#runningSessions.get(agentSessionId) === candidate && !candidate.initialization) {
        session = candidate;
        break;
      }
      this.#releaseTurn(candidate);
    }

    let processingEmitted = false;
    try {
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }

      session.options = mergeClaudeSessionOptions(session.options, allOpts);

    const effectiveChatId = chatId || session.chatId;
    session.chatId = effectiveChatId;
    session.isRunning = true;
    session.lastActivityAt = Date.now();
    session.eventMetadata = claudeEventMetadata({ clientRequestId, turnId });
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
    this.#sendUserMessage(session, command, images);
    executionAdmission?.markStarted();
    processingEmitted = true;
    this.emitProcessing(effectiveChatId, true);
    onAbortable?.();
      await this.#waitForTurnComplete(session);
    } catch (error) {
      if (session.isRunning) {
        if (!processingEmitted) session.isRunning = false;
        this.#retireSession(session);
      }
      throw error;
    } finally {
      this.#releaseTurn(session);
    }
  }

  async abortClaudeInternalSession(agentSessionId: string): Promise<boolean> {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session?.process) return false;

    const sent = this.#trySendToCLI(agentSessionId, JSON.stringify({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    }));
    if (!sent) return false;

    const proc = session.process;
    this.#clearAbortTimer(session);
    session.abortTimer = setTimeout(() => {
      session.abortTimer = null;
      // Only fires when the interrupt was never acknowledged: the same process
      // is still stuck on the aborted turn. An acknowledged interrupt or a new
      // turn clears this timer first, so a reused process is never killed here.
      if (session.process === proc && !proc.killed) {
        this.#dependencies.logger.warn('Claude CLI interrupt was not acknowledged', {
          sessionId: agentSessionId.slice(0, 8),
        });
        // Mark this exit as the abort's own kill so it reads as a clean stop.
        session.abortKilledProc = proc;
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
    return session?.isRunning === true;
  }

  getRunningClaudeInternalSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#runningSessions.entries())
      .filter(([, s]) => s.isRunning)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.startTime).toISOString(),
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
      if (session.process && !session.process.killed) {
        session.process.kill();
      }
      if (session.isRunning) {
        session.isRunning = false;
        this.emitProcessing(session.chatId, false);
      }
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve?.();
      this.#completeSessionInitialization(session);
    }
    this.#runningSessions.clear();
    this.#pendingPermissions.clear();
    this.#pendingControlRequests.clear();
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
