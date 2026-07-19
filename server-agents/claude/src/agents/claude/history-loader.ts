// Path-based wrappers for Claude JSONL reading.
// Accepts absolute nativePath instead of (projectName, agentSessionId).

import { promises as fs } from 'fs';
import path from 'path';
import {
  readJsonlLineEntries,
  readJsonlTailLines,
} from '@garcon/server-agent-common/shared/history-loader-utils';
import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  ErrorMessage,
  CompactionMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { convertClaudeToolUse } from './tool-use-converter.js';
import { extractCompactionSummary, parseCompactMetadata } from './compaction.js';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { attachNativeMessageSource, getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { createLogger } from '@garcon/server-agent-common/lib/log';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import type { AgentTranscriptPage } from '@garcon/server-agent-common/legacy/types';
import {
  TranscriptRevisionAccumulator,
  attachCompactionRevisionSource,
  transcriptRevision,
} from '@garcon/server-agent-common/lib/transcript-revision';
import { deterministicTranscriptTimestamp } from '@garcon/server-agent-common/shared/transcript-timestamp';
import { compareTranscriptTimestamps } from '@garcon/server-agent-common/shared/transcript-order';

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

interface OrderedClaudeMessage {
  message: ChatMessage;
  timestamp: number;
  sourceOrder: number;
  partOrder: number;
}

interface OrderedCompactionBoundary {
  timestamp: number;
  sourceOrder: number;
  info: ReturnType<typeof parseCompactMetadata>;
}

class BoundedLatest<T> {
  #items: T[] = [];

  constructor(
    private readonly limit: number,
    private readonly compare: (left: T, right: T) => number,
  ) {}

  add(candidate: T): void {
    if (this.limit === 0) return;
    if (this.#items.length < this.limit) {
      this.#items.push(candidate);
      this.#siftUp(this.#items.length - 1);
    } else if (this.compare(candidate, this.#items[0]) > 0) {
      this.#items[0] = candidate;
      this.#siftDown(0);
    }
  }

  values(): T[] {
    return this.#items;
  }

  #siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.#items[parent], this.#items[index]) <= 0) break;
      [this.#items[parent], this.#items[index]] = [this.#items[index], this.#items[parent]];
      index = parent;
    }
  }

  #siftDown(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.#items.length && this.compare(this.#items[left], this.#items[smallest]) < 0) smallest = left;
      if (right < this.#items.length && this.compare(this.#items[right], this.#items[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [this.#items[index], this.#items[smallest]] = [this.#items[smallest], this.#items[index]];
      index = smallest;
    }
  }
}

function compareOrderedClaudeMessages(
  left: OrderedClaudeMessage,
  right: OrderedClaudeMessage,
): number {
  return compareTranscriptTimestamps(left.timestamp, right.timestamp)
    || left.sourceOrder - right.sourceOrder
    || left.partOrder - right.partOrder;
}

function compareCompactionBoundaries(
  left: OrderedCompactionBoundary,
  right: OrderedCompactionBoundary,
): number {
  return compareTranscriptTimestamps(left.timestamp, right.timestamp)
    || left.sourceOrder - right.sourceOrder;
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
  if (typeof value !== 'string') return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
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

function toolResultContentForEntry(
  entry: Record<string, unknown>,
  content: unknown,
): Record<string, unknown> {
  const normalized = normalizeToolResultContent(content);
  const toolUseResult = entry.toolUseResult;
  if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
    return { ...normalized, toolUseResult: toolUseResult as Record<string, unknown> };
  }
  return normalized;
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
  const parsed = parseFirstJsonlValue<Record<string, unknown>>(line);
  if (parsed.kind !== 'value') return null;
  const entry = asRecord(parsed.value);
  return entry.sessionId ? entry : null;
}

export function parseClaudeJsonlEntryWithSource(
  line: string,
  lineNumber: number,
): Record<string, unknown> | null {
  const entry = parseClaudeJsonlEntry(line);
  if (!entry) return null;
  const entryId = asString(entry.uuid) || asString(entry.id) || asString(entry.messageId);
  return attachNativeMessageSource(entry, {
    lineNumber,
    ...(entryId ? { entryId } : {}),
  });
}

export function sortClaudeEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = timestampMs(a.entry.timestamp);
      const right = timestampMs(b.entry.timestamp);
      return compareTranscriptTimestamps(left, right) || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function convertClaudeEntries(entries: Record<string, unknown>[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const sourceOrdinals = new WeakMap<Record<string, unknown>, number>();

  function pushMessage(entry: Record<string, unknown>, message: ChatMessage): void {
    const withinSourceOrdinal = sourceOrdinals.get(entry) ?? 0;
    sourceOrdinals.set(entry, withinSourceOrdinal + 1);
    messages.push(attachNativeMessageSource(message, {
      ...getNativeMessageSource(entry),
      withinSourceOrdinal,
    }));
  }

  // A compact_boundary and its summary carry near-identical timestamps and can be
  // reordered by the chronological sort, so collect boundary metadata up front and
  // pair it FIFO with the summaries rather than relying on boundary-before-summary order.
  const compactions = entries
    .filter((entry) => entry.type === 'system' && entry.subtype === 'compact_boundary')
    .map((entry) => ({
      info: parseCompactMetadata(entry.compactMetadata ?? entry.compact_metadata),
      source: {
        ...getNativeMessageSource(entry),
        pairingTimestamp: timestampMs(entry.timestamp),
      },
    }));
  let compactionIndex = 0;

  for (const entry of entries) {
    const source = getNativeMessageSource(entry);
    const ts = asString(entry.timestamp)
      || deterministicTranscriptTimestamp(source?.lineNumber, source?.byteOffset);
    const message = asRecord(entry.message);

    if (entry.type === 'progress' || entry.type === 'queue-operation' ||
      entry.type === 'file-history-snapshot' || entry.type === 'summary') {
      continue;
    }

    if (entry.type === 'system') continue;

    if (entry.isCompactSummary) {
      const summaryText = getMessageText(message.content);
      if (summaryText) {
        const compaction = compactions[compactionIndex++];
        const info = compaction?.info ?? { trigger: 'manual' as const };
        const compactionMessage = new CompactionMessage(
          ts,
          info.trigger,
          extractCompactionSummary(summaryText),
          info.preTokens,
          info.postTokens,
        );
        pushMessage(
          entry,
          attachCompactionRevisionSource(compactionMessage, compaction?.source),
        );
      }
      continue;
    }

    if (entry.isMeta) continue;

    if (entry.isApiErrorMessage) {
      const errorText = entry.error
        ? (typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error))
        : getMessageText(message.content) || 'API error';
      pushMessage(entry, new ErrorMessage(ts, errorText));
      continue;
    }

    if (message.role === 'user') {
      const content = message.content;

      if (Array.isArray(content)) {
        for (const rawPart of content) {
          const part = asRecord(rawPart);
          if (part.type === 'tool_result') {
            pushMessage(entry, new ToolResultMessage(ts, asString(part.tool_use_id) || '', toolResultContentForEntry(entry, part.content), Boolean(part.is_error)));
          }
        }
      }

      const text = getMessageText(content);
      if (text && !isSystemUserMessage(text)) {
        pushMessage(entry, new UserMessage(ts, stripResolvedFileMentionContext(text)));
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
            pushMessage(entry, new ThinkingMessage(ts, thinking));
          } else if (part.type === 'text' && text?.trim()) {
            if (!isSystemAssistantMessage(text)) {
              pushMessage(entry, new AssistantMessage(ts, text));
            }
          } else if (part.type === 'tool_use') {
            pushMessage(entry, convertClaudeToolUse(ts, part));
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        if (!isSystemAssistantMessage(content)) {
          pushMessage(entry, new AssistantMessage(ts, content));
        }
      }
      continue;
    }

    if (entry.type === 'thinking' && message.content) {
      const thinkContent = typeof message.content === 'string'
        ? message.content : '';
      if (thinkContent) {
        pushMessage(entry, new ThinkingMessage(ts, thinkContent));
      }
    }
  }

  return messages;
}

function parseClaudeJsonlLines(lines: string[]): ChatMessage[] {
  return convertClaudeEntries(sortClaudeEntries(lines
    .map((line, index) => parseClaudeJsonlEntryWithSource(line, index + 1))
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

async function scanClaudeMessagePage(
  nativePath: string,
  windowSize: number,
): Promise<{
  total: number;
  messages: ChatMessage[];
  revision: string;
  requiresFullLoad: boolean;
}> {
  let total = 0;
  let sourceOrder = 0;
  let totalCompactionSummaries = 0;
  let totalCompactionBoundaries = 0;
  let requiresFullLoad = false;
  const revision = new TranscriptRevisionAccumulator();
  const messages = new BoundedLatest<OrderedClaudeMessage>(
    windowSize,
    compareOrderedClaudeMessages,
  );
  const compactionSummaries = new BoundedLatest<OrderedClaudeMessage>(
    windowSize,
    compareOrderedClaudeMessages,
  );
  const compactionBoundaries = new BoundedLatest<OrderedCompactionBoundary>(
    windowSize,
    compareCompactionBoundaries,
  );
  for await (const lineEntry of readJsonlLineEntries(nativePath)) {
    const entry = parseClaudeJsonlEntryWithSource(lineEntry.line, lineEntry.lineNumber ?? 1);
    if (!entry) {
      sourceOrder += 1;
      continue;
    }
    const entryTimestamp = timestampMs(entry.timestamp);
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const info = parseCompactMetadata(entry.compactMetadata ?? entry.compact_metadata);
      compactionBoundaries.add({
        timestamp: entryTimestamp,
        sourceOrder,
        info,
      });
      revision.addCompactionMetadata(info, {
        ...(getNativeMessageSource(entry) ?? { sourceOrder }),
        pairingTimestamp: entryTimestamp,
      });
      totalCompactionBoundaries += 1;
    }
    const converted = convertClaudeEntries([entry]);
    if (
      (converted.length > 0 || entry.type === 'system' && entry.subtype === 'compact_boundary')
      && entryTimestamp <= 0
    ) {
      requiresFullLoad = true;
    }
    converted.forEach((message, partOrder) => {
      const candidate = { message, timestamp: entryTimestamp, sourceOrder, partOrder };
      messages.add(candidate);
      revision.add(message, { deferCompactionMetadata: message.type === 'compaction' });
      total += 1;
      if (message.type === 'compaction') {
        compactionSummaries.add(candidate);
        totalCompactionSummaries += 1;
      }
    });
    sourceOrder += 1;
  }

  if (totalCompactionBoundaries !== totalCompactionSummaries) requiresFullLoad = true;
  const retainedBoundaries = compactionBoundaries.values().sort(compareCompactionBoundaries);
  const retainedSummaries = compactionSummaries.values().sort(compareOrderedClaudeMessages);
  retainedSummaries.forEach((candidate, index) => {
    const summaryIndex = totalCompactionSummaries - retainedSummaries.length + index;
    const retainedBoundaryIndex = summaryIndex
      - (totalCompactionBoundaries - retainedBoundaries.length);
    const info = retainedBoundaries[retainedBoundaryIndex]?.info;
    if (!info || candidate.message.type !== 'compaction') return;
    candidate.message.trigger = info.trigger;
    candidate.message.preTokens = info.preTokens;
    candidate.message.postTokens = info.postTokens;
  });

  return {
    total,
    messages: messages.values().sort(compareOrderedClaudeMessages).map((entry) => entry.message),
    revision: revision.finish(),
    requiresFullLoad,
  };
}

export async function loadClaudeChatMessagePage(
  nativePath: string | null | undefined,
  limit: number,
  offset: number,
): Promise<AgentTranscriptPage | null> {
  if (
    !nativePath
    || !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(limit)
    || limit <= 0
    || offset > Number.MAX_SAFE_INTEGER - limit
  ) return null;
  try {
    await fs.access(nativePath);
  } catch {
    return { messages: [], total: 0, hasMore: false, offset, limit };
  }

  try {
    // Retains the newest offset + limit messages because exact arbitrary-offset
    // selection under global timestamp ordering requires the skipped suffix too.
    const scan = await scanClaudeMessagePage(nativePath, offset + limit);
    if (scan.requiresFullLoad) {
      return pageFromMessages(await loadClaudeChatMessages(nativePath), limit, offset);
    }
    const { total, messages, revision } = scan;
    if (offset >= total) {
      return { messages: [], total, hasMore: false, offset, limit, revision };
    }

    const end = Math.max(0, messages.length - offset);
    const start = Math.max(0, end - limit);
    const pageMessages = messages.slice(start, end);
    return {
      messages: pageMessages,
      total,
      hasMore: total > offset + pageMessages.length,
      offset,
      limit,
      revision,
    };
  } catch (error) {
    logger.warn(`claude: tail page load failed for ${nativePath}:`, error);
    return null;
  }
}

function pageFromMessages(
  messages: ChatMessage[],
  limit: number,
  offset: number,
): AgentTranscriptPage {
  const total = messages.length;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    total,
    hasMore: start > 0,
    offset,
    limit,
    revision: transcriptRevision(messages),
  };
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
      const entry = parseClaudeJsonlEntry(line);
      if (entry) messages.push(entry);
    }

    messages.sort((a, b) => compareTranscriptTimestamps(
      timestampMs(a.timestamp),
      timestampMs(b.timestamp),
    ));

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
      const entry = parseClaudeJsonlEntry(line);
      if (!entry) continue;
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
    const entry = parseClaudeJsonlEntry(lines[i]);
    if (!entry) continue;
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
