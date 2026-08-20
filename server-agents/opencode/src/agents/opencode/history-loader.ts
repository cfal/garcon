import {
  UserMessage,
  AssistantMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import path from 'node:path';
import { convertOpenCodeToolUse } from './tool-use-converter.js';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  createOpenCodeRequestScope,
  hasOpenCodeResultError,
  isOpenCodeNotFoundResult,
  openCodeResultErrorMessage,
  withOpenCodeRequestScope,
} from './sdk-result.js';

const SILENT_LOGGER: AgentLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

interface OpenCodeSession {
  directory?: string;
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
  limit?: number;
}

export class OpenCodeTranscriptNotFoundError extends Error {
  constructor() {
    super('OpenCode transcript session not found');
    this.name = 'OpenCodeTranscriptNotFoundError';
  }
}

type OpenCodeStoredMessagesResult =
  | { readonly kind: 'found'; readonly messages: OpenCodeMessage[] }
  | { readonly kind: 'not-found' };

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
  try {
    const result = await requestOpenCodeStoredMessages(sessionId, getClient, options);
    return result.kind === 'found' ? result.messages : [];
  } catch (err) {
    if (options.throwOnError) throw err;
    logger.error('OpenCode chat message load failed', {
      sessionId: sessionId ?? null,
      error: errorMessage(err),
    });
    return [];
  }
}

async function requestOpenCodeStoredMessages(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions,
): Promise<OpenCodeStoredMessagesResult> {
  if (!sessionId) return { kind: 'not-found' };
  const client = await getClient();
  const scope = createOpenCodeRequestScope(options.directory);
  const args = withOpenCodeRequestScope({
    sessionID: sessionId,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  }, scope);
  const result = options.signal
    ? await client.session.messages(args, { signal: options.signal })
    : await client.session.messages(args);
  if (isOpenCodeNotFoundResult(result)) return { kind: 'not-found' };
  if (hasOpenCodeResultError(result)) {
    throw new Error(openCodeResultErrorMessage(result, 'OpenCode message fetch failed'));
  }
  if (!Array.isArray(result.data)) {
    throw new Error('OpenCode message fetch returned an invalid payload');
  }
  return { kind: 'found', messages: result.data };
}

async function requestScopedOpenCodeStoredMessages(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions,
): Promise<OpenCodeStoredMessagesResult> {
  if (!sessionId) return { kind: 'not-found' };
  const client = await getClient();
  const scope = createOpenCodeRequestScope(options.directory);
  const sessionArgs = withOpenCodeRequestScope({ sessionID: sessionId }, scope);
  const sessionResult = await client.session.get(sessionArgs);
  if (isOpenCodeNotFoundResult(sessionResult)) {
    return { kind: 'not-found' };
  }
  if (hasOpenCodeResultError(sessionResult)) {
    throw new Error(openCodeResultErrorMessage(sessionResult, 'OpenCode session fetch failed'));
  }
  if (!sessionResult.data) {
    throw new Error('OpenCode session fetch returned an invalid payload');
  }
  if (scope.directory) {
    if (typeof sessionResult.data.directory !== 'string' || !sessionResult.data.directory) {
      throw new Error('OpenCode session fetch returned a session without a directory');
    }
    if (path.resolve(sessionResult.data.directory) !== path.resolve(scope.directory)) {
      return { kind: 'not-found' };
    }
  }
  const messages = await requestOpenCodeStoredMessages(sessionId, getClient, options);
  if (messages.kind === 'not-found') {
    throw new Error('OpenCode transcript messages disappeared during import');
  }
  return messages;
}

export function convertOpenCodeStoredMessages(rawMessages: readonly OpenCodeMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // Rows keep provider part order, and every row carries its stable provider
  // identity: part rows the part ID, message-level rows the message ID. Live
  // conversion attaches the same tuples, so audits match without guessing.
  const push = (message: ChatMessage, entryId: unknown, withinSourceOrdinal = 0): void => {
    messages.push(typeof entryId === 'string' && entryId.length > 0
      ? attachNativeMessageSource(message, { entryId, withinSourceOrdinal })
      : message);
  };
  for (const msg of visibleOpenCodeStoredMessages(rawMessages)) {
    const info = msg.info || {};
    const ts = dateToIso(info.time?.created)
      ?? new Date().toISOString();

    if (info.role === 'user') {
      const text = extractUserTextFromParts(msg.parts || []);
      if (text?.trim()) {
        push(new UserMessage(ts, stripResolvedFileMentionContext(text)), info.id);
      }
      continue;
    }

    if (info.role === 'assistant') {
      const providerError = openCodeStoredErrorMessage(info.error);
      const aborted = isOpenCodeStoredAbort(info.error);
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
            push(new ThinkingMessage(ts, content), part.id);
          }
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          push(new AssistantMessage(ts, part.text), part.id);
        } else if (part.type === 'tool' && !aborted) {
          const state = asRecord(part.state);
          const toolUse = convertOpenCodeToolUse(ts, part);
          push(toolUse, part.id);

          if (state.status === 'completed') {
            push(new ToolResultMessage(
              ts,
              toolUse.toolId,
              normalizeToolResultContent(state.output),
              false,
            ), part.id, 1);
          } else if (state.status === 'error') {
            push(new ToolResultMessage(
              ts,
              toolUse.toolId,
              normalizeToolResultContent(state.error || 'Error'),
              true,
            ), part.id, 1);
          }
        }
      }
      if (providerError) push(new ErrorMessage(ts, providerError), info.id);
    }
  }
  return messages;
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

export async function loadLegacyOpenCodeChatMessages(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions = {},
): Promise<ChatMessage[]> {
  // A chat that records no native session is the only positive legacy absence.
  // A recorded session the provider cannot return within scope is loss, not
  // absence: adoption must fail and retry later instead of permanently
  // committing a false-empty view.
  if (!sessionId) return [];
  return loadRequiredOpenCodeChatMessages(sessionId, getClient, options);
}

export async function loadRequiredOpenCodeChatMessages(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions = {},
): Promise<ChatMessage[]> {
  const result = await requestScopedOpenCodeStoredMessages(sessionId, getClient, options);
  if (result.kind === 'not-found') throw new OpenCodeTranscriptNotFoundError();
  return convertImportableOpenCodeStoredMessages(result.messages);
}

function convertImportableOpenCodeStoredMessages(
  messages: readonly OpenCodeMessage[],
): ChatMessage[] {
  for (const message of messages) {
    const info = asRecord(message.info);
    if (
      typeof info.id !== 'string'
      || !info.id
      || (info.role !== 'user' && info.role !== 'assistant')
      || !Array.isArray(message.parts)
    ) {
      throw new Error('OpenCode stored transcript message is invalid');
    }
    for (const part of message.parts) {
      const rawPart = part as Record<string, unknown>;
      if (
        !part
        || typeof part !== 'object'
        || Array.isArray(part)
        || typeof rawPart.type !== 'string'
        || !rawPart.type
        || (rawPart.type === 'text' && typeof rawPart.text !== 'string')
        || (
          rawPart.type === 'reasoning'
          && typeof rawPart.reasoning !== 'string'
          && typeof rawPart.text !== 'string'
        )
      ) {
        throw new Error('OpenCode stored transcript part is invalid');
      }
    }
  }
  return convertOpenCodeStoredMessages(messages);
}

export function latestOpenCodeStoredActivityAt(
  rawMessages: readonly OpenCodeMessage[],
): string | null {
  const messages = visibleOpenCodeStoredMessages(rawMessages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (convertOpenCodeStoredMessages([message]).length === 0) continue;
    return dateToIso(message.info?.time?.created);
  }
  return null;
}
