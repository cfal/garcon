// Path-based wrappers for Claude JSONL reading.
// Accepts absolute nativePath instead of (projectName, agentSessionId).

import { promises as fs } from 'fs';
import path from 'path';
import { readJsonlTailLines } from '../shared/history-loader-utils.ts';
import { normalizeToolResultContent } from '../shared/normalize-util.js';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  ErrorMessage,
  CompactionMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { convertClaudeToolUse } from './tool-use-converter.js';
import { extractCompactionSummary, parseCompactMetadata } from './compaction.js';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.ts';
import { createLogger } from '../../lib/log.js';
import type { AgentTranscriptPage } from '../types.js';

const logger = createLogger('agents:claude:history-loader');

const HEAD_READ_BYTES = 32 * 1024;

interface ClaudePreview {
  firstMessage: string;
  lastMessage: string;
  lastActivity: string | null;
  createdAt: string | number | null;
}

interface PaginatedRawMessages {
  messages: Record<string, unknown>[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function timestampMs(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function getMessageText(content: unknown): string {
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => asRecord(part))
      .map((part) => typeof part.text === 'string' ? part.text.trim() : '')
      .filter(Boolean);
    return textParts.join('\n');
  }
  if (typeof content === 'string') {
    return content.trim();
  }
  return '';
}

function isSystemUserMessage(text: string): boolean {
  return (
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') ||
    text.startsWith('<command-args>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<system-reminder>') ||
    text.startsWith('Caveat:') ||
    text.startsWith('This session is being continued from a previous') ||
    text.startsWith('Invalid API key') ||
    text.includes('{"subtasks":') ||
    text.includes('CRITICAL: You MUST respond with ONLY a JSON') ||
    text === 'Warmup'
  );
}

function isSystemAssistantMessage(text: string): boolean {
  return (
    text.startsWith('Invalid API key') ||
    text.includes('{"subtasks":') ||
    text.includes('CRITICAL: You MUST respond with ONLY a JSON')
  );
}

function parseClaudeJsonlEntry(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const entry = asRecord(JSON.parse(line));
    return entry.sessionId ? entry : null;
  } catch {
    return null;
  }
}

function sortClaudeEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = timestampMs(a.entry.timestamp);
      const right = timestampMs(b.entry.timestamp);
      if (left > 0 && right > 0 && left !== right) return left - right;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function convertClaudeEntries(entries: Record<string, unknown>[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // A compact_boundary and its summary carry near-identical timestamps and can be
  // reordered by the chronological sort, so collect boundary metadata up front and
  // pair it FIFO with the summaries rather than relying on boundary-before-summary order.
  const compactions = entries
    .filter((entry) => entry.type === 'system' && entry.subtype === 'compact_boundary')
    .map((entry) => parseCompactMetadata(entry.compactMetadata ?? entry.compact_metadata));
  let compactionIndex = 0;

  for (const entry of entries) {
    const ts = asString(entry.timestamp) || new Date().toISOString();
    const message = asRecord(entry.message);

    if (entry.type === 'progress' || entry.type === 'queue-operation' ||
      entry.type === 'file-history-snapshot' || entry.type === 'summary') {
      continue;
    }

    if (entry.type === 'system') continue;

    if (entry.isCompactSummary) {
      const summaryText = getMessageText(message.content);
      if (summaryText) {
        const info = compactions[compactionIndex++] ?? { trigger: 'manual' as const };
        messages.push(new CompactionMessage(ts, info.trigger, extractCompactionSummary(summaryText), info.preTokens, info.postTokens));
      }
      continue;
    }

    if (entry.isMeta) continue;

    if (entry.isApiErrorMessage) {
      const errorText = entry.error
        ? (typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error))
        : getMessageText(message.content) || 'API error';
      messages.push(new ErrorMessage(ts, errorText));
      continue;
    }

    if (message.role === 'user') {
      const content = message.content;

      if (Array.isArray(content)) {
        for (const rawPart of content) {
          const part = asRecord(rawPart);
          if (part.type === 'tool_result') {
            messages.push(new ToolResultMessage(ts, asString(part.tool_use_id) || '', normalizeToolResultContent(part.content), Boolean(part.is_error)));
          }
        }
      }

      const text = getMessageText(content);
      if (text && !isSystemUserMessage(text)) {
        messages.push(new UserMessage(ts, stripResolvedFileMentionContext(decodeHtmlEntities(text))));
      }
      continue;
    }

    if (message.role === 'assistant' && message.content) {
      const content = message.content;

      if (Array.isArray(content)) {
        for (const rawPart of content) {
          const part = asRecord(rawPart);
          const thinking = asString(part.thinking);
          const text = asString(part.text);
          if (part.type === 'thinking' && thinking) {
            messages.push(new ThinkingMessage(ts, thinking));
          } else if (part.type === 'text' && text?.trim()) {
            if (!isSystemAssistantMessage(text)) {
              messages.push(new AssistantMessage(ts, text));
            }
          } else if (part.type === 'tool_use') {
            messages.push(convertClaudeToolUse(ts, part));
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        if (!isSystemAssistantMessage(content)) {
          messages.push(new AssistantMessage(ts, content));
        }
      }
      continue;
    }

    if (entry.type === 'thinking' && message.content) {
      const thinkContent = typeof message.content === 'string'
        ? message.content : '';
      if (thinkContent) {
        messages.push(new ThinkingMessage(ts, thinkContent));
      }
    }
  }

  return messages;
}

function parseClaudeJsonlLines(lines: string[]): ChatMessage[] {
  return convertClaudeEntries(sortClaudeEntries(lines
    .map(parseClaudeJsonlEntry)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))));
}

// Reads a Claude JSONL file and returns ChatMessage[].
export async function loadClaudeChatMessages(nativePath: string | null | undefined): Promise<ChatMessage[]> {
  if (!nativePath) return [];
  try {
    await fs.access(nativePath);
  } catch {
    return [];
  }

  try {
    const raw = await fs.readFile(nativePath, 'utf8');
    return parseClaudeJsonlLines(raw.split('\n'));
  } catch (error) {
    logger.error(`claude: error loading chat messages from ${nativePath}:`, error);
    return [];
  }
}

export async function loadClaudeChatMessagePage(
  nativePath: string | null | undefined,
  limit: number,
  offset: number,
): Promise<AgentTranscriptPage | null> {
  if (!nativePath || offset > 0 || limit <= 0) return null;
  try {
    await fs.access(nativePath);
  } catch {
    return { messages: [], total: 0, hasMore: false, offset, limit };
  }

  try {
    let maxBytes = 256 * 1024;
    let maxLines = Math.max(500, limit * 40);
    while (true) {
      const { lines, fullyRead } = await readJsonlTailLines(nativePath, maxBytes, maxLines);
      const messages = parseClaudeJsonlLines(lines);
      if (messages.length >= limit || fullyRead) {
        const pageMessages = messages.slice(Math.max(0, messages.length - limit));
        const hasMore = !fullyRead || messages.length > pageMessages.length;
        return {
          messages: pageMessages,
          total: fullyRead ? messages.length : pageMessages.length + 1,
          hasMore,
          offset,
          limit,
        };
      }
      maxBytes *= 2;
      maxLines *= 2;
    }
  } catch (error) {
    logger.warn(`claude: tail page load failed for ${nativePath}:`, error);
    return null;
  }
}

// Reads session messages from an absolute JSONL path.
export async function getClaudeSessionMessagesFromNativePath(
  nativePath: string,
  limit: number | null = null,
  offset = 0,
): Promise<Record<string, unknown>[] | PaginatedRawMessages> {
  try {
    await fs.access(nativePath);
  } catch {
    return limit === null ? [] : { messages: [], total: 0, hasMore: false, offset, limit };
  }

  try {
    const raw = await fs.readFile(nativePath, 'utf8');
    const messages: Record<string, unknown>[] = [];

    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const entry = asRecord(JSON.parse(line));
        if (entry.sessionId) {
          messages.push(entry);
        }
      } catch { }
    }

    messages.sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp));

    const total = messages.length;

    if (limit === null) {
      return messages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = messages.slice(startIndex, endIndex);

    return {
      messages: paginatedMessages,
      total,
      hasMore: startIndex > 0,
      offset,
      limit,
    };
  } catch (error) {
    logger.error(`claude: error reading messages from ${nativePath}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false, offset, limit };
  }
}

// Reads the head of a JSONL file to find the first user message.
async function readFirstUserMessage(filePath: string): Promise<{
  firstMessage: string | null;
  firstTimestamp: string | number | null;
}> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  let firstTimestamp: string | number | null = null;
  let firstMessage: string | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const stats = await fh.stat();
    const readSize = Math.min(HEAD_READ_BYTES, stats.size);
    if (readSize === 0) return { firstMessage: null, firstTimestamp: null };

    const buffer = Buffer.alloc(readSize);
    await fh.read(buffer, 0, readSize, 0);

    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if ((typeof entry.timestamp === 'string' || typeof entry.timestamp === 'number') && !firstTimestamp) {
        firstTimestamp = entry.timestamp;
      }
      const message = asRecord(entry.message);
      if (message.role !== 'user') {
        continue;
      }
      const text = getMessageText(message.content);
      if (text && !isSystemUserMessage(text)) {
        firstMessage = text;
      }
      if (firstMessage) {
        if (firstTimestamp) {
          break;
        }
        logger.error(`claude: got first user message without timestamp: ${firstMessage}`);
      }
    }
  } catch { } finally {
    await fh?.close();
  }
  return { firstMessage, firstTimestamp };
}

// Builds a preview (title, lastActivity, etc.) from an absolute JSONL path.
export async function getClaudePreviewFromNativePath(nativePath: string): Promise<ClaudePreview | null> {
  const agentSessionId = path.basename(nativePath, '.jsonl');

  try {
    await fs.access(nativePath);
  } catch (err) {
    logger.error(`claude: preview fetch failed for ${nativePath}:`, err);
    return null;
  }

  const { lines, fullyRead } = await readJsonlTailLines(nativePath);
  if (fullyRead) {
    logger.warn(`claude: fully read ${nativePath}`);
  }

  let lastActivity: string | null = null;
  let lastMessage: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Record<string, unknown>;
    try {
      entry = asRecord(JSON.parse(lines[i]));
    } catch {
      continue;
    }

    if (!entry.sessionId) continue;
    if (entry.sessionId !== agentSessionId) {
      logger.warn(`claude: skipping non-matching session ID in ${nativePath}, expected ${agentSessionId}: ${String(entry.sessionId)}`);
      continue;
    }

    if (!lastActivity && (typeof entry.timestamp === 'string' || typeof entry.timestamp === 'number')) {
      const timestamp = new Date(entry.timestamp);
      if (!Number.isNaN(timestamp.getTime())) {
        const currentTime = timestamp.toISOString();
        lastActivity = currentTime;
      }
    }

    if (!lastMessage) {
      const message = asRecord(entry.message);
      const role = message.role;
      if (role === 'user') {
        const text = getMessageText(message.content);
        if (!text || isSystemUserMessage(text)) {
          continue;
        }
        lastMessage = '> ' + text;
      } else if (role === 'assistant' && entry.isApiErrorMessage !== true) {
        const text = getMessageText(message.content);
        if (!text || isSystemAssistantMessage(text)) {
          continue;
        }
        lastMessage = text;
      }
    }
    if (lastActivity && lastMessage) {
      break;
    }
  }

  // TODO: It's possible that the full file was already read if it's small enough (see `fullyRead`),
  // in which case we could have handled it in the loop above.
  const { firstMessage, firstTimestamp } = await readFirstUserMessage(nativePath);
  if (!firstMessage || !firstTimestamp) {
    logger.warn(`claude: failed to read first user message from ${nativePath}`);
  }

  return {
    firstMessage: firstMessage || 'Unknown Claude Session',
    lastMessage: lastMessage || '',
    lastActivity: lastActivity,
    createdAt: firstTimestamp || null,
  };
}
