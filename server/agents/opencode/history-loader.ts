// Wraps OpenCode SDK API calls to match the interface expected by
// the metadata and chat event loaders. Reads session history and
// preview data via the SDK rather than JSONL files.
//
// Both exported functions accept a getClient callback: () => Promise<client>.
// The composition root binds this to the OpenCodeRuntime instance.

import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { convertOpenCodeToolUse } from './tool-use-converter.js';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.ts';
import { normalizeToolResultContent } from '../shared/normalize-util.js';
import { createLogger } from '../../lib/log.js';
import { errorMessage } from '../../lib/errors.js';
import {
  createOpenCodeRequestScope,
  hasOpenCodeResultError,
  isOpenCodeNotFoundResult,
  openCodeResultErrorMessage,
  withOpenCodeRequestScope,
  type OpenCodeRequestScope,
} from './sdk-result.js';

const logger = createLogger('agents:opencode:history-loader');

const PREVIEW_TAIL_MESSAGE_LIMIT = 20;

interface OpenCodeSession {
  title?: string;
  time?: {
    created?: string | number | Date;
    updated?: string | number | Date;
  };
}

interface OpenCodeMessage {
  info?: {
    role?: string;
    time?: {
      created?: string | number | Date;
    };
  };
  parts?: unknown[] | string;
}

interface OpenCodeClient {
  session: {
    get(args: { sessionID: string; directory?: string }): Promise<{ data?: OpenCodeSession | null }>;
    messages(args: { sessionID: string; limit?: number; directory?: string }): Promise<{ data?: OpenCodeMessage[] | null }>;
  };
}

type OpenCodeClientGetter = () => Promise<OpenCodeClient>;

interface OpenCodeHistoryLoadOptions {
  directory?: string | null;
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
): Promise<{ result: T; scope: OpenCodeRequestScope }> {
  const result = await operation(scope);
  if (!scope.directory || !isOpenCodeNotFoundResult(result)) return { result, scope };

  const fallbackScope: OpenCodeRequestScope = {};
  const fallbackResult = await operation(fallbackScope);
  if (!isOpenCodeNotFoundResult(fallbackResult)) {
    logger.warn(`opencode: ${label} missed directory ${scope.directory}; loaded without directory`);
  }
  return { result: fallbackResult, scope: fallbackScope };
}

// Returns preview metadata for a session (title, last message, etc.).
export async function getOpenCodePreviewFromSessionId(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions = {},
): Promise<OpenCodePreview | null> {
  if (!sessionId) {
    logger.error('opencode: preview fetch failed, sessionId is required');
    return null;
  }
  try {
    const client = await getClient();
    const initialScope = createOpenCodeRequestScope(options.directory);
    const { result, scope } = await callWithDirectoryFallback(
      'preview fetch',
      initialScope,
      (requestScope) => client.session.get(withOpenCodeRequestScope({ sessionID: sessionId }, requestScope)),
    );
    if (isOpenCodeNotFoundResult(result)) return null;
    if (hasOpenCodeResultError(result)) {
      logger.warn(
        `opencode: preview fetch failed for ${sessionId}:`,
        openCodeResultErrorMessage(result, 'OpenCode preview fetch failed'),
      );
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
    );
    if (isOpenCodeNotFoundResult(messageResult)) return null;
    if (hasOpenCodeResultError(messageResult)) {
      logger.warn(
        `opencode: preview message fetch failed for ${sessionId}:`,
        openCodeResultErrorMessage(messageResult, 'OpenCode preview message fetch failed'),
      );
      return null;
    }
    const messages = Array.isArray(messageResult.data) ? messageResult.data : [];
    let lastMessage = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const info = message.info || {};
      if (info.role === 'user') {
        const text = extractTextFromParts(message.parts || []);
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
    logger.error(`opencode: preview fetch failed for ${sessionId}:`, err);
    return null;
  }
}

function extractTextFromParts(parts: unknown[] | string): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => asRecord(p))
    .filter((p) => p.type === 'text')
    .map((p) => typeof p.text === 'string' ? p.text : '')
    .join('\n');
}

// Fetches messages for an OpenCode session and returns ChatMessage[].
export async function loadOpenCodeChatMessages(
  sessionId: string | null | undefined,
  getClient: OpenCodeClientGetter,
  options: OpenCodeHistoryLoadOptions = {},
): Promise<ChatMessage[]> {
  if (!sessionId) return [];
  try {
    const client = await getClient();
    const { result } = await callWithDirectoryFallback(
      'message fetch',
      createOpenCodeRequestScope(options.directory),
      (scope) => client.session.messages(withOpenCodeRequestScope({ sessionID: sessionId }, scope)),
    );
    if (isOpenCodeNotFoundResult(result)) return [];
    if (hasOpenCodeResultError(result)) {
      logger.warn(
        `opencode: failed to load chat messages for session ${sessionId}:`,
        openCodeResultErrorMessage(result, 'OpenCode message fetch failed'),
      );
      return [];
    }
    const rawMessages = Array.isArray(result.data) ? result.data : [];

    const messages: ChatMessage[] = [];
    for (const msg of rawMessages) {
      const info = msg.info || {};
      const ts = dateToIso(info.time?.created)
        ?? new Date().toISOString();

      if (info.role === 'user') {
        const text = extractTextFromParts(msg.parts || []);
        if (text?.trim()) {
          messages.push(new UserMessage(ts, stripResolvedFileMentionContext(text)));
        }
        continue;
      }

      if (info.role === 'assistant') {
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
              messages.push(new ThinkingMessage(ts, content));
            }
          }
        }

        // Emit text and tool-use parts
        for (const rawPart of parts) {
          const part = asRecord(rawPart);
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            messages.push(new AssistantMessage(ts, part.text));
          } else if (part.type === 'tool') {
            const toolId = typeof part.callID === 'string'
              ? part.callID
              : typeof part.id === 'string'
                ? part.id
                : '';
            messages.push(convertOpenCodeToolUse(ts, part));
            const state = asRecord(part.state);

            // Emit tool result if completed or errored
            if (state.status === 'completed') {
              messages.push(new ToolResultMessage(ts, toolId, normalizeToolResultContent(state.output), false));
            } else if (state.status === 'error') {
              messages.push(new ToolResultMessage(ts, toolId, normalizeToolResultContent(state.error || 'Error'), true));
            }
          }
        }
      }
    }

    return messages;
  } catch (err) {
    logger.error(`opencode: failed to load chat messages for session ${sessionId}:`, errorMessage(err));
    return [];
  }
}
