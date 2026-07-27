import { AssistantMessage, ThinkingMessage, ToolResultMessage } from '@garcon/common/chat-types';
import type { ChatMessage } from '@garcon/common/chat-types';
import { convertClaudeToolUse } from './tool-use-converter.js';
import { claudeToolResultContent } from './tool-result-converter.js';

interface CompactMetadata {
  trigger?: string;
  pre_tokens?: number;
  post_tokens?: number;
}

export interface ClaudeCLIMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  isReplay?: boolean;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  api_error_status?: number | string | null;
  error_status?: number | string | null;
  error?: string;
  errors?: unknown[];
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  duration_ms?: number;
  num_turns?: number;
  stop_reason?: string | null;
  terminal_reason?: string;
  result?: unknown;
  user_message_uuid?: string;
  command_uuid?: string;
  state?: string;
  tasks?: unknown[];
  permission_denials?: unknown[];
  content?: unknown[];
  message?: { role?: string; content?: unknown };
  request_id?: string;
  status?: string | null;
  compact_result?: string;
  compact_error?: string;
  tool_use_result?: unknown;
  toolUseResult?: unknown;
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

export interface ClaudeApiRetryDiagnostics {
  attempt: number | null;
  maxRetries: number | null;
  delayMs: number | null;
  errorStatus: number | string | null;
  error: string | null;
}

export type ClaudeTurnStartSource = 'lifecycle' | 'replay';
export type ClaudeTurnTerminalState = 'completed' | 'cancelled' | 'discarded';
export type ClaudeTurnPhase = 'submitted' | 'started' | 'interrupting';
export type ClaudeProviderSessionState = 'unknown' | 'running' | 'requires_action' | 'idle';
export type ClaudeReportedSessionState = Exclude<ClaudeProviderSessionState, 'unknown'>;
export type ClaudeTurnInputEvent =
  | { type: 'started'; source: ClaudeTurnStartSource }
  | { type: 'terminal-before-start'; state: ClaudeTurnTerminalState };
export type ClaudeResultCorrelation = 'before-start' | 'input' | 'continuation' | 'mismatched';

function isClaudeContentPart(value: unknown): value is ClaudeContentPart {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function claudeResultFailureMessage(message: ClaudeCLIMessage): string {
  const result = typeof message.result === 'string' ? message.result.trim() : '';
  if (result) return result.slice(0, 4_000);
  const errors = Array.isArray(message.errors)
    ? message.errors
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0 && !entry.startsWith('[ede_diagnostic]'))
    : [];
  if (errors.length > 0) return errors.join('\n').slice(0, 4_000);
  const outcome = message.subtype || message.terminal_reason || 'unknown error';
  const apiStatus = message.api_error_status === null || message.api_error_status === undefined
    ? ''
    : ` (API status ${message.api_error_status})`;
  return `Claude CLI turn failed: ${outcome}${apiStatus}`;
}

export function claudeProviderSessionState(
  message: ClaudeCLIMessage,
): ClaudeReportedSessionState | null {
  if (
    message.type !== 'system'
    || message.subtype !== 'session_state_changed'
  ) {
    return null;
  }
  if (
    message.state === 'running'
    || message.state === 'requires_action'
    || message.state === 'idle'
  ) {
    return message.state;
  }
  return null;
}

export function claudeBackgroundTaskCount(message: ClaudeCLIMessage): number | null {
  if (
    message.type !== 'system'
    || message.subtype !== 'background_tasks_changed'
    || !Array.isArray(message.tasks)
  ) {
    return null;
  }
  return message.tasks.length;
}

export class ClaudeTurnState {
  readonly inputUuid: string;
  #phase: ClaudeTurnPhase = 'submitted';
  #inputStarted = false;
  #outputMessageCount = 0;
  #assistantContentSeen = false;
  #assistantContentVersion = 0;
  #lastResultAssistantContentVersion = 0;
  #acceptedResultCount = 0;
  #resultFailure: string | null = null;
  #cleanAbortResultSeen = false;
  #backgroundContinuationPending = false;
  #backgroundContinuationStarted = false;
  #lastApiRetry: ClaudeApiRetryDiagnostics | null = null;
  #resultBeforeStart: ClaudeCLIMessage | null = null;

  constructor(inputUuid: string) {
    this.inputUuid = inputUuid;
  }

  get phase(): ClaudeTurnPhase {
    return this.#phase;
  }

  get inputStarted(): boolean {
    return this.#inputStarted;
  }

  get abortRequested(): boolean {
    return this.#phase === 'interrupting';
  }

  get outputMessageCount(): number {
    return this.#outputMessageCount;
  }

  get assistantContentSeen(): boolean {
    return this.#assistantContentSeen;
  }

  get assistantContentSinceLastResult(): boolean {
    return this.#assistantContentVersion > this.#lastResultAssistantContentVersion;
  }

  get hasAcceptedResult(): boolean {
    return this.#acceptedResultCount > 0;
  }

  get cleanAbortResultSeen(): boolean {
    return this.#cleanAbortResultSeen;
  }

  get backgroundContinuationPending(): boolean {
    return this.#backgroundContinuationPending;
  }

  observeInput(message: ClaudeCLIMessage): ClaudeTurnInputEvent | null {
    if (
      !this.inputStarted
      && message.type === 'command_lifecycle'
      && message.state === 'started'
      && message.command_uuid === this.inputUuid
    ) {
      this.#inputStarted = true;
      if (this.#phase !== 'interrupting') this.#phase = 'started';
      this.#resultBeforeStart = null;
      return { type: 'started', source: 'lifecycle' };
    }
    if (
      !this.inputStarted
      && message.type === 'user'
      && message.isReplay === true
      && message.uuid === this.inputUuid
    ) {
      this.#inputStarted = true;
      if (this.#phase !== 'interrupting') this.#phase = 'started';
      this.#resultBeforeStart = null;
      return { type: 'started', source: 'replay' };
    }
    if (
      !this.inputStarted
      && message.type === 'command_lifecycle'
      && message.command_uuid === this.inputUuid
      && (
        message.state === 'completed'
        || message.state === 'cancelled'
        || message.state === 'discarded'
      )
    ) {
      return { type: 'terminal-before-start', state: message.state };
    }
    return null;
  }

  markAbortRequested(): void {
    this.#phase = 'interrupting';
  }

  observeBackgroundTaskCount(count: number): void {
    if (count <= 0) return;
    this.#backgroundContinuationPending = true;
    this.#backgroundContinuationStarted = false;
  }

  observeProviderSessionState(
    state: ClaudeReportedSessionState,
    backgroundTaskCount: number,
  ): void {
    // An empty task set precedes the provider-owned completion turn, so the
    // following running/result pair closes the continuation fence.
    if (
      state === 'running'
      && this.hasAcceptedResult
      && this.#backgroundContinuationPending
      && backgroundTaskCount === 0
    ) {
      this.#backgroundContinuationStarted = true;
    }
  }

  recordResultBeforeStart(message: ClaudeCLIMessage): void {
    if (!this.inputStarted) this.#resultBeforeStart = message;
  }

  takeResultBeforeStart(): ClaudeCLIMessage | null {
    const result = this.#resultBeforeStart;
    this.#resultBeforeStart = null;
    return result;
  }

  addOutputMessages(count: number, assistantContentSeen = false): void {
    this.#outputMessageCount += count;
    this.#assistantContentSeen ||= assistantContentSeen;
    if (assistantContentSeen) this.#assistantContentVersion += 1;
  }

  recordApiRetry(message: ClaudeCLIMessage): ClaudeApiRetryDiagnostics {
    const retry = {
      attempt: message.attempt ?? null,
      maxRetries: message.max_retries ?? null,
      delayMs: message.retry_delay_ms ?? null,
      errorStatus: message.error_status ?? null,
      error: typeof message.error === 'string' ? message.error.slice(0, 200) : null,
    };
    if (this.inputStarted) this.#lastApiRetry = retry;
    return retry;
  }

  correlateResult(message: ClaudeCLIMessage): ClaudeResultCorrelation {
    if (!this.inputStarted) return 'before-start';
    if (
      !this.hasAcceptedResult
      && message.user_message_uuid
      && message.user_message_uuid !== this.inputUuid
    ) {
      return 'mismatched';
    }
    return this.hasAcceptedResult ? 'continuation' : 'input';
  }

  recordAcceptedResult(message: ClaudeCLIMessage): void {
    this.#acceptedResultCount += 1;
    this.#lastResultAssistantContentVersion = this.#assistantContentVersion;
    if (this.#backgroundContinuationStarted) {
      this.#backgroundContinuationPending = false;
      this.#backgroundContinuationStarted = false;
    }
    if (!message.is_error) return;
    if (
      this.abortRequested
      && message.terminal_reason === 'aborted_streaming'
    ) {
      this.#cleanAbortResultSeen = true;
      return;
    }
    this.#resultFailure ??= claudeResultFailureMessage(message);
  }

  settlementFailureMessage(): string | null {
    if (this.#resultFailure) return this.#resultFailure;
    if (this.#cleanAbortResultSeen) return null;
    if (!this.#assistantContentSeen) return this.emptyCompletionFailureMessage();
    return null;
  }

  get recordedResultFailureMessage(): string | null {
    return this.#resultFailure;
  }

  emptyCompletionFailureMessage(): string {
    const retry = this.#lastApiRetry;
    if (!retry) {
      return 'Claude CLI completed the submitted message without producing a response.';
    }
    const status = retry.errorStatus ?? 'unknown status';
    const error = retry.error ? ` ${retry.error}` : '';
    const attempt = retry.attempt === null
      ? ''
      : ` (attempt ${retry.attempt}${retry.maxRetries === null ? '' : `/${retry.maxRetries}`})`;
    return `Claude CLI completed the submitted message without producing a response. Last API retry: ${status}${error}${attempt}.`;
  }
}

// Converts user-visible CLI content to canonical messages.
export function convertCLIMessageToChatMessages(message: ClaudeCLIMessage): ChatMessage[] {
  const isAssistant = message.type === 'assistant';
  const isUser = message.type === 'user';
  if (!isAssistant && !isUser) return [];

  const chatMessages: ChatMessage[] = [];
  const now = new Date().toISOString();
  const rawContent =
    Array.isArray(message.content) ? message.content
      : Array.isArray(message.message?.content) ? message.message.content
        : [];
  const content = rawContent.filter(isClaudeContentPart);

  for (const part of content) {
    if (isAssistant && part.type === 'text' && part.text?.trim()) {
      chatMessages.push(new AssistantMessage(now, part.text));
    }
    if (isAssistant && part.type === 'thinking' && part.thinking) {
      chatMessages.push(new ThinkingMessage(now, part.thinking));
    }
    if (isAssistant && part.type === 'tool_use') {
      chatMessages.push(convertClaudeToolUse(now, part));
    }
    if (part.type === 'tool_result') {
      chatMessages.push(new ToolResultMessage(
        now,
        part.tool_use_id || '',
        claudeToolResultContent(
          part.content,
          message.tool_use_result ?? message.toolUseResult,
        ),
        Boolean(part.is_error),
      ));
    }
  }

  return chatMessages;
}
