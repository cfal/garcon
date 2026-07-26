import { AssistantMessage, ThinkingMessage, ToolResultMessage } from '@garcon/common/chat-types';
import type { ChatMessage } from '@garcon/common/chat-types';
import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import { convertClaudeToolUse } from './tool-use-converter.js';

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
  command_uuid?: string;
  state?: string;
  permission_denials?: unknown[];
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

export interface ClaudeApiRetryDiagnostics {
  attempt: number | null;
  maxRetries: number | null;
  delayMs: number | null;
  errorStatus: number | string | null;
  error: string | null;
}

export type ClaudeTurnStartSource = 'lifecycle' | 'replay';
export type ClaudeTurnTerminalState = 'completed' | 'cancelled' | 'discarded';
export type ClaudeTurnInputEvent =
  | { type: 'started'; source: ClaudeTurnStartSource }
  | { type: 'terminal-before-start'; state: ClaudeTurnTerminalState };

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

export class ClaudeTurnTracker {
  #inputUuid: string | null = null;
  #inputStarted = false;
  #abortRequested = false;
  #outputMessageCount = 0;
  #lastApiRetry: ClaudeApiRetryDiagnostics | null = null;
  #resultBeforeStart: ClaudeCLIMessage | null = null;

  get inputUuid(): string | null {
    return this.#inputUuid;
  }

  get inputStarted(): boolean {
    return this.#inputStarted;
  }

  get abortRequested(): boolean {
    return this.#abortRequested;
  }

  get outputMessageCount(): number {
    return this.#outputMessageCount;
  }

  beginInput(inputUuid: string): void {
    this.#inputUuid = inputUuid;
    this.#inputStarted = false;
    this.#abortRequested = false;
    this.#outputMessageCount = 0;
    this.#lastApiRetry = null;
    this.#resultBeforeStart = null;
  }

  observeInput(message: ClaudeCLIMessage): ClaudeTurnInputEvent | null {
    if (!this.#inputUuid) return null;
    if (
      !this.#inputStarted
      && message.type === 'command_lifecycle'
      && message.state === 'started'
      && message.command_uuid === this.#inputUuid
    ) {
      this.#inputStarted = true;
      this.#resultBeforeStart = null;
      return { type: 'started', source: 'lifecycle' };
    }
    if (
      !this.#inputStarted
      && message.type === 'user'
      && message.isReplay === true
      && message.uuid === this.#inputUuid
    ) {
      this.#inputStarted = true;
      this.#resultBeforeStart = null;
      return { type: 'started', source: 'replay' };
    }
    if (
      !this.#inputStarted
      && message.type === 'command_lifecycle'
      && message.command_uuid === this.#inputUuid
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
    this.#abortRequested = true;
  }

  clearAbortRequested(): void {
    this.#abortRequested = false;
  }

  recordResultBeforeStart(message: ClaudeCLIMessage): void {
    if (!this.#inputStarted) this.#resultBeforeStart = message;
  }

  takeResultBeforeStart(): ClaudeCLIMessage | null {
    const result = this.#resultBeforeStart;
    this.#resultBeforeStart = null;
    return result;
  }

  addOutputMessages(count: number): void {
    this.#outputMessageCount += count;
  }

  recordApiRetry(message: ClaudeCLIMessage): ClaudeApiRetryDiagnostics {
    const retry = {
      attempt: message.attempt ?? null,
      maxRetries: message.max_retries ?? null,
      delayMs: message.retry_delay_ms ?? null,
      errorStatus: message.error_status ?? null,
      error: typeof message.error === 'string' ? message.error.slice(0, 200) : null,
    };
    if (this.#inputStarted) this.#lastApiRetry = retry;
    return retry;
  }

  completedWithoutResponse(message: ClaudeCLIMessage): boolean {
    return !message.is_error
      && this.#outputMessageCount === 0
      && (typeof message.result !== 'string' || message.result.trim().length === 0);
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

// Converts a finalized CLI assistant message to ChatMessage objects.
export function convertCLIMessageToChatMessages(message: ClaudeCLIMessage): ChatMessage[] {
  if (message.type !== 'assistant') return [];

  const chatMessages: ChatMessage[] = [];
  const now = new Date().toISOString();
  const rawContent =
    Array.isArray(message.content) ? message.content
      : Array.isArray(message.message?.content) ? message.message.content
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
      chatMessages.push(new ToolResultMessage(
        now,
        part.tool_use_id || '',
        normalizeToolResultContent(part.content),
        Boolean(part.is_error),
      ));
    }
  }

  return chatMessages;
}
