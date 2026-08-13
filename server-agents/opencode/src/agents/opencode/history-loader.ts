// Wraps OpenCode SDK API calls to match the interface expected by
// the metadata and chat event loaders. Reads session history and
// preview data via the SDK rather than JSONL files.
//
// Both exported functions accept a getClient callback: () => Promise<client>.
// The composition root binds this to the OpenCodeRuntime instance.

import {
  UserMessage,
  AssistantMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { convertOpenCodeToolUse } from './tool-use-converter.js';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  createOpenCodeRequestScope,
  hasOpenCodeResultError,
  isOpenCodeNotFoundResult,
  openCodeResultErrorMessage,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';

const SILENT_LOGGER: AgentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

const PREVIEW_TAIL_MESSAGE_LIMIT = 20;

interface OpenCodeSession {
  title?: string;
  time?: {
    created?: string | number | Date;
    updated?: string | number | Date;
  };
}

export interface OpenCodeMessage {
  info?: {
    id?: string;
    role?: string;
    mode?: string;
    agent?: string;
    summary?: boolean;
    error?: unknown;
    time?: {
      created?: string | number | Date;
    };
  };
  parts?: unknown[] | string;
}

interface OpenCodeClient {
  session: {
    get(args: { sessionID: string; directory?: string }): Promise<{ data?: OpenCodeSession | null }>;
    messages(
      args: { sessionID: string; limit?: number; directory?: string },
      options?: { signal?: AbortSignal },
    ): Promise<{ data?: OpenCodeMessage[] | null }>;
  };
}

export type OpenCodeClientGetter = () => Promise<OpenCodeClient>;

export interface OpenCodeHistoryLoadOptions {
  directory?: string | null;
  signal?: AbortSignal;
  throwOnError?: boolean;
  logger?: AgentLogger;
}

interface OpenCodePreview {
  firstMessage: string;
  lastMessage: string;
  lastActivity: string | null;
  createdAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function dateToIso(value: string | number | Date | undefined): string | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function callWithDirectoryFallback<T>(
  label: string,
  scope: OpenCodeRequestScope,
  operation: (scope: OpenCodeRequestScope) => Promise<T>,
  logger: AgentLogger,
): Promise<{ result: T; scope: OpenCodeRequestScope }> {
  const result = await operation(scope);
  if (!scope.directory || !isOpenCodeNotFoundResult(result)) return { result, scope };

  const fallbackScope: OpenCodeRequestScope = {};
  const fallbackResult = await operation(fallbackScope);
  if (!isOpenCodeNotFoundResult(fallbackResult)) {
    logger.warn('OpenCode request missed the scoped directory; loaded without it', {
      label,
      directory: scope.directory,
    });
  }
  return { result: fallbackResult, scope: fallbackScope };
}

// Returns preview metadata for a session (title, last message, etc.).
export async function getOpenCodePreviewFromSessionId(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions = {},
): Promise<OpenCodePreview | null> {
  const logger = options.logger ?? SILENT_LOGGER;
  if (!sessionId) {
    logger.error('OpenCode preview fetch requires a session ID');
    return null;
  }
  try {
    const client = await getClient();
    const initialScope = createOpenCodeRequestScope(options.directory);
    const { result, scope } = await callWithDirectoryFallback(
      'preview fetch',
      initialScope,
      (requestScope) => client.session.get(withOpenCodeRequestScope({ sessionID: sessionId }, requestScope)),
      logger,
    );
    if (isOpenCodeNotFoundResult(result)) return null;
    if (hasOpenCodeResultError(result)) {
      logger.warn('OpenCode preview fetch failed', {
        sessionId,
        error: openCodeResultErrorMessage(result, 'OpenCode preview fetch failed'),
      });
      return null;
    }
    const session = result.data;
    if (!session) return null;
    const { result: messageResult } = await callWithDirectoryFallback(
      'preview message fetch',
      scope,
      (requestScope) => client.session.messages(withOpenCodeRequestScope({
        sessionID: sessionId,
        limit: PREVIEW_TAIL_MESSAGE_LIMIT,
      }, requestScope)),
      logger,
    );
    if (isOpenCodeNotFoundResult(messageResult)) return null;
    if (hasOpenCodeResultError(messageResult)) {
      logger.warn('OpenCode preview message fetch failed', {
        sessionId,
        error: openCodeResultErrorMessage(messageResult, 'OpenCode preview message fetch failed'),
      });
      return null;
    }
    const messages = visibleOpenCodeStoredMessages(
      Array.isArray(messageResult.data) ? messageResult.data : [],
    );
    let lastMessage = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const info = message.info || {};
      if (info.role === 'user') {
        const text = extractUserTextFromParts(message.parts || []);
        lastMessage = text.trim();
      } else if (info.role === 'assistant') {
        const parts = Array.isArray(message.parts) ? message.parts : [];
        for (const rawPart of parts) {
          const part = asRecord(rawPart);
          if (part.type === 'text') {
            const text = typeof part.text === 'string' ? part.text.trim() : '';
            lastMessage = text || '';
          }
        }
      }
      if (lastMessage) break;
    }

    return {
      // TODO: this is incorrect, we should be returning the first user message instead of the generated title.
      // TODO: is there a way to disable OpenCode title generation?
      firstMessage: session.title || 'Unknown OpenCode Session',
      lastMessage,
      lastActivity: dateToIso(session.time?.updated),
      createdAt: dateToIso(session.time?.created),
    };
  } catch (err) {
    logger.error('OpenCode preview fetch failed', {
      sessionId,
      error: errorMessage(err),
    });
    return null;
  }
}

function extractUserTextFromParts(parts: unknown[] | string): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => asRecord(p))
    .filter((p) => p.type === 'text' && p.synthetic !== true)
    .map((p) => typeof p.text === 'string' ? p.text : '')
    .join('\n');
}

function isCompactionAssistant(info: NonNullable<OpenCodeMessage['info']>): boolean {
  return info.summary === true || info.mode === 'compaction' || info.agent === 'compaction';
}

// OpenCode persists compaction summaries and continuation prompts as ordinary messages.
// The overflow path also replays the original prompt after its successful summary.
function visibleOpenCodeStoredMessages(rawMessages: readonly OpenCodeMessage[]): OpenCodeMessage[] {
  const visible: OpenCodeMessage[] = [];
  let overflowCompactionPending = false;
  let replayExpectedText: string | null = null;
  let lastVisibleUserText: string | null = null;

  for (const message of rawMessages) {
    const info = message.info ?? {};
    const parts = Array.isArray(message.parts) ? message.parts.map(asRecord) : [];

    if (info.role === 'user') {
      const compaction = parts.find((part) => part.type === 'compaction');
      if (compaction) {
        overflowCompactionPending = compaction.overflow === true;
        replayExpectedText = null;
        continue;
      }

      const text = extractUserTextFromParts(message.parts ?? []);
      if (!text.trim()) {
        if (parts.some((part) => part.type === 'text' && part.synthetic === true)) {
          overflowCompactionPending = false;
          replayExpectedText = null;
        }
        continue;
      }

      overflowCompactionPending = false;
      if (replayExpectedText !== null) {
        const isReplay = text === replayExpectedText;
        replayExpectedText = null;
        if (isReplay) continue;
      }
      visible.push(message);
      lastVisibleUserText = text;
      continue;
    }

    if (info.role === 'assistant' && isCompactionAssistant(info)) {
      const succeeded = info.error == null;
      replayExpectedText = overflowCompactionPending && succeeded
        ? lastVisibleUserText
        : null;
      overflowCompactionPending = false;
      // A failed summary remains internal, but its provider failure must survive reload.
      if (!succeeded) visible.push({ ...message, parts: [] });
      continue;
    }

    overflowCompactionPending = false;
    replayExpectedText = null;
    visible.push(message);
  }

  return visible;
}

function isOpenCodeStoredAbort(error: unknown): boolean {
  return asRecord(error).name === 'MessageAbortedError';
}

function openCodeStoredErrorMessage(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === 'string') return error.trim() || 'OpenCode session failed';
  const record = asRecord(error);
  if (isOpenCodeStoredAbort(error)) return null;
  const data = asRecord(record.data);
  if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof record.name === 'string' && record.name.trim()) return record.name.trim();
  return 'OpenCode session failed';
}

export async function fetchOpenCodeStoredMessages(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions = {},
): Promise<OpenCodeMessage[]> {
  const logger = options.logger ?? SILENT_LOGGER;
  if (!sessionId) return [];
  try {
    const client = await getClient();
    const { result } = await callWithDirectoryFallback(
      'message fetch',
      createOpenCodeRequestScope(options.directory),
      (scope) => {
        const args = withOpenCodeRequestScope({ sessionID: sessionId }, scope);
        return options.signal
          ? client.session.messages(args, { signal: options.signal })
          : client.session.messages(args);
      },
      logger,
    );
    if (isOpenCodeNotFoundResult(result)) return [];
    if (hasOpenCodeResultError(result)) {
      const message = openCodeResultErrorMessage(result, 'OpenCode message fetch failed');
      if (options.throwOnError) throw new Error(message);
      logger.warn('OpenCode chat message load failed', { sessionId, error: message });
      return [];
    }
    if (Array.isArray(result.data)) return result.data;
    if (options.throwOnError) throw new Error('OpenCode message fetch returned an invalid payload');
    logger.warn('OpenCode chat message load returned an invalid payload', { sessionId });
    return [];
  } catch (err) {
    if (options.throwOnError) throw err;
    logger.error('OpenCode chat message load failed', {
      sessionId,
      error: errorMessage(err),
    });
    return [];
  }
}

export function convertOpenCodeStoredMessages(rawMessages: readonly OpenCodeMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const msg of visibleOpenCodeStoredMessages(rawMessages)) {
    const converted: ChatMessage[] = [];
    const info = msg.info || {};
    const ts = dateToIso(info.time?.created)
      ?? new Date().toISOString();

    if (info.role === 'user') {
      const text = extractUserTextFromParts(msg.parts || []);
      if (text?.trim()) {
        converted.push(new UserMessage(ts, stripResolvedFileMentionContext(text)));
      }
      appendOpenCodeSource(messages, converted, info.id);
      continue;
    }

    if (info.role === 'assistant') {
      const providerError = openCodeStoredErrorMessage(info.error);
      const aborted = isOpenCodeStoredAbort(info.error);
      // Emit thinking parts first
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        if (part.type === 'reasoning') {
          const content = typeof part.reasoning === 'string'
            ? part.reasoning
            : typeof part.text === 'string'
              ? part.text
              : '';
          if (content.trim()) {
            converted.push(new ThinkingMessage(ts, content));
          }
        }
      }

      // Emit text and tool-use parts
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          converted.push(new AssistantMessage(ts, part.text));
        } else if (part.type === 'tool' && !aborted) {
          const state = asRecord(part.state);
          const toolUse = convertOpenCodeToolUse(ts, part);
          converted.push(toolUse);

          // Emit tool result if completed or errored
          if (state.status === 'completed') {
            converted.push(new ToolResultMessage(
              ts,
              toolUse.toolId,
              normalizeToolResultContent(state.output),
              false,
            ));
          } else if (state.status === 'error') {
            converted.push(new ToolResultMessage(
              ts,
              toolUse.toolId,
              normalizeToolResultContent(state.error || 'Error'),
              true,
            ));
          }
        }
      }
      if (providerError) converted.push(new ErrorMessage(ts, providerError));
    }
    appendOpenCodeSource(messages, converted, info.id);
  }
  return messages;
}

function appendOpenCodeSource(
  messages: ChatMessage[],
  converted: ChatMessage[],
  entryId: string | undefined,
): void {
  converted.forEach((message, withinSourceOrdinal) => {
    messages.push(attachNativeMessageSource(message, {
      ...(entryId ? { entryId } : {}),
      withinSourceOrdinal,
    }));
  });
}

// Fetches messages for an OpenCode session and returns ChatMessage[].
export async function loadOpenCodeChatMessages(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions = {},
): Promise<ChatMessage[]> {
  const stored = await fetchOpenCodeStoredMessages(sessionId, getClient, options);
  return convertOpenCodeStoredMessages(stored);
}
