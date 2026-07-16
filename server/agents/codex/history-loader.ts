// Path-based wrappers for Codex JSONL reading.
// Accepts absolute nativePath instead of scanning ~/.codex/sessions/.

import { promises as fs } from 'fs';
import { readJsonlLineEntries, readJsonlTailLines } from '../shared/history-loader-utils.ts';
import {
  normalizeCodexJsonlEntry,
  extractTextContent,
  type CodexJsonlNormalizationContext,
} from './history-normalizer.js';
import { attachNativeMessageSource } from '../shared/native-message-source.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { AgentTranscriptPage } from '../types.js';
import { createLogger } from '../../lib/log.js';
import { parseFirstJsonlValue } from '../../lib/jsonl.js';
import {
  TranscriptRevisionAccumulator,
  transcriptRevision,
} from '../../lib/transcript-revision.js';

const logger = createLogger('agents:codex:history-loader');

interface CodexMessageBuckets {
  canonical: ChatMessage[];
  fallbackUser: ChatMessage[];
  fallbackAssistant: ChatMessage[];
  fallbackThinking: ChatMessage[];
  hasCanonicalUser: boolean;
  hasCanonicalAssistant: boolean;
  hasCanonicalThinking: boolean;
}

interface CodexMessageSummary {
  canonical: number;
  fallbackUser: number;
  fallbackAssistant: number;
  fallbackThinking: number;
  hasCanonicalUser: boolean;
  hasCanonicalAssistant: boolean;
  hasCanonicalThinking: boolean;
  total: number;
}

interface OrderedMessage {
  message: ChatMessage;
  timestamp: number;
  order: number;
}

class BoundedLatestMessages {
  #items: OrderedMessage[] = [];

  constructor(private readonly limit: number) {}

  add(message: ChatMessage, order: number): void {
    if (this.limit === 0) return;
    const candidate = { message, timestamp: timestampMs(message.timestamp), order };
    if (this.#items.length < this.limit) {
      this.#items.push(candidate);
      this.#siftUp(this.#items.length - 1);
    } else if (compareOrderedMessages(candidate, this.#items[0]) > 0) {
      this.#items[0] = candidate;
      this.#siftDown(0);
    }
  }

  values(): OrderedMessage[] {
    return this.#items;
  }

  #siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareOrderedMessages(this.#items[parent], this.#items[index]) <= 0) break;
      [this.#items[parent], this.#items[index]] = [this.#items[index], this.#items[parent]];
      index = parent;
    }
  }

  #siftDown(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.#items.length && compareOrderedMessages(this.#items[left], this.#items[smallest]) < 0) smallest = left;
      if (right < this.#items.length && compareOrderedMessages(this.#items[right], this.#items[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [this.#items[index], this.#items[smallest]] = [this.#items[smallest], this.#items[index]];
      index = smallest;
    }
  }
}

function timestampMs(value: unknown): number {
  const time = new Date((value as string | number | Date | undefined) ?? 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareOrderedMessages(left: OrderedMessage, right: OrderedMessage): number {
  if (left.timestamp > 0 && right.timestamp > 0 && left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left.order - right.order;
}

function sortChatMessagesByTimestamp(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const left = new Date(a.message.timestamp || 0).getTime();
      const right = new Date(b.message.timestamp || 0).getTime();
      if (left > 0 && right > 0 && left !== right) return left - right;
      return a.index - b.index;
    })
    .map(({ message }) => message);
}

function createCodexMessageBuckets(): CodexMessageBuckets {
  return {
    canonical: [],
    fallbackUser: [],
    fallbackAssistant: [],
    fallbackThinking: [],
    hasCanonicalUser: false,
    hasCanonicalAssistant: false,
    hasCanonicalThinking: false,
  };
}

function addCodexJsonlLine(
  buckets: CodexMessageBuckets,
  line: string,
  context: CodexJsonlNormalizationContext = {},
): boolean {
  const entry = parseCodexJsonlEntry(line);
  if (!entry) return false;
  try {
    const result = normalizeCodexJsonlEntry(entry, context);
    if (!result) return false;

    let withinSourceOrdinal = 0;
    const appendMessages = (target: ChatMessage[], messages: ChatMessage[]): void => {
      for (const message of messages) {
        target.push(attachNativeMessageSource(message, {
          byteOffset: context.sourceByteOffset,
          lineNumber: context.sourceLineNumber,
          withinSourceOrdinal,
        }));
        withinSourceOrdinal += 1;
      }
    };
    appendMessages(buckets.canonical, result.canonical);
    appendMessages(buckets.fallbackUser, result.fallbackUser);
    appendMessages(buckets.fallbackAssistant, result.fallbackAssistant);
    appendMessages(buckets.fallbackThinking, result.fallbackThinking);
    if (result.isCanonicalUser) buckets.hasCanonicalUser = true;
    if (result.isCanonicalAssistant) buckets.hasCanonicalAssistant = true;
    if (result.isCanonicalThinking) buckets.hasCanonicalThinking = true;
    const emitted = result.canonical.length
      + result.fallbackUser.length
      + result.fallbackAssistant.length
      + result.fallbackThinking.length > 0;
    return emitted && (
      typeof entry.timestamp !== 'string'
      || timestampMs(entry.timestamp) <= 0
    );
  } catch {
    return false;
  }
}

function parseCodexJsonlEntry(line: string): Record<string, unknown> | null {
  const parsed = parseFirstJsonlValue<Record<string, unknown>>(line);
  return parsed.kind === 'value' ? asRecord(parsed.value) : null;
}

function finishCodexMessages(buckets: CodexMessageBuckets, includeFallback: boolean): ChatMessage[] {
  const messages = [...buckets.canonical];
  if (includeFallback && !buckets.hasCanonicalUser) messages.push(...buckets.fallbackUser);
  if (includeFallback && !buckets.hasCanonicalAssistant) messages.push(...buckets.fallbackAssistant);
  if (includeFallback && !buckets.hasCanonicalThinking) messages.push(...buckets.fallbackThinking);
  return sortChatMessagesByTimestamp(messages);
}

async function scanCodexMessagePage(
  nativePath: string,
  windowSize: number,
): Promise<{
  summary: CodexMessageSummary;
  messages: ChatMessage[];
  revision: string;
  requiresFullLoad: boolean;
}> {
  const summary: CodexMessageSummary = {
    canonical: 0,
    fallbackUser: 0,
    fallbackAssistant: 0,
    fallbackThinking: 0,
    hasCanonicalUser: false,
    hasCanonicalAssistant: false,
    hasCanonicalThinking: false,
    total: 0,
  };
  const bucketNames = [
    'canonical',
    'fallbackUser',
    'fallbackAssistant',
    'fallbackThinking',
  ] as const;
  const windows = Object.fromEntries(
    bucketNames.map((name) => [name, new BoundedLatestMessages(windowSize)]),
  ) as Record<(typeof bucketNames)[number], BoundedLatestMessages>;
  const revisions = Object.fromEntries(
    bucketNames.map((name) => [name, new TranscriptRevisionAccumulator()]),
  ) as Record<(typeof bucketNames)[number], TranscriptRevisionAccumulator>;
  let requiresFullLoad = false;

  for await (const entry of readJsonlLineEntries(nativePath)) {
    const buckets = createCodexMessageBuckets();
    const hasMalformedTimestamp = addCodexJsonlLine(buckets, entry.line, {
      sourceByteOffset: entry.byteOffset,
      sourceLineNumber: entry.lineNumber,
    });
    requiresFullLoad ||= hasMalformedTimestamp;
    for (const name of bucketNames) {
      for (const message of buckets[name]) {
        windows[name].add(message, summary[name]);
        revisions[name].add(message);
        summary[name] += 1;
      }
    }
    summary.hasCanonicalUser ||= buckets.hasCanonicalUser;
    summary.hasCanonicalAssistant ||= buckets.hasCanonicalAssistant;
    summary.hasCanonicalThinking ||= buckets.hasCanonicalThinking;
  }

  summary.total = summary.canonical
    + (summary.hasCanonicalUser ? 0 : summary.fallbackUser)
    + (summary.hasCanonicalAssistant ? 0 : summary.fallbackAssistant)
    + (summary.hasCanonicalThinking ? 0 : summary.fallbackThinking);
  const includedNames = [
    'canonical',
    ...(!summary.hasCanonicalUser ? ['fallbackUser'] as const : []),
    ...(!summary.hasCanonicalAssistant ? ['fallbackAssistant'] as const : []),
    ...(!summary.hasCanonicalThinking ? ['fallbackThinking'] as const : []),
  ] as const;
  const combined = includedNames.flatMap((name, bucketRank) => {
    const bucketStart = includedNames
      .slice(0, bucketRank)
      .reduce((count, previousName) => count + summary[previousName], 0);
    return windows[name].values().map((entry) => ({
      ...entry,
      order: bucketStart + entry.order,
    }));
  });
  combined.sort(compareOrderedMessages);
  const revision = new TranscriptRevisionAccumulator();
  for (const name of includedNames) revision.merge(revisions[name]);
  return {
    summary,
    messages: combined.slice(-Math.min(summary.total, windowSize)).map((entry) => entry.message),
    revision: revision.finish(),
    requiresFullLoad,
  };
}

// Reads a Codex JSONL file and returns ChatMessage[].
// Uses per-content-class dedup. event_msg user messages are treated as
// canonical transcript content, while response_item user messages are
// only included as fallback when event_msg user entries are missing.
export async function loadCodexChatMessages(nativePath: string | null | undefined): Promise<ChatMessage[]> {
  if (!nativePath) return [];

  try {
    const buckets = createCodexMessageBuckets();

    for await (const entry of readJsonlLineEntries(nativePath)) {
      addCodexJsonlLine(buckets, entry.line, {
        sourceByteOffset: entry.byteOffset,
        sourceLineNumber: entry.lineNumber,
      });
    }

    return finishCodexMessages(buckets, true);
  } catch (error) {
    logger.error(`Error loading Codex ChatMessages from ${nativePath}:`, error);
    return [];
  }
}

export async function loadCodexChatMessagePage(
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
    // Retains the newest offset + limit messages because exact arbitrary-offset
    // selection under global timestamp ordering requires the skipped suffix too.
    const windowSize = offset + limit;
    const scan = await scanCodexMessagePage(nativePath, windowSize);
    if (scan.requiresFullLoad) {
      return pageFromMessages(await loadCodexChatMessages(nativePath), limit, offset);
    }
    const { summary, messages, revision } = scan;
    if (offset >= summary.total) {
      return { messages: [], total: summary.total, hasMore: false, offset, limit, revision };
    }
    const end = Math.max(0, messages.length - offset);
    const start = Math.max(0, end - limit);
    const pageMessages = messages.slice(start, end);
    return {
      messages: pageMessages,
      total: summary.total,
      hasMore: summary.total > offset + pageMessages.length,
      offset,
      limit,
      revision,
    };
  } catch (error) {
    logger.warn(`codex: tail page load failed for ${nativePath}:`, error);
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
  const pageMessages = messages.slice(start, end);
  return {
    messages: pageMessages,
    total,
    hasMore: start > 0,
    offset,
    limit,
    revision: transcriptRevision(messages),
  };
}

const CODEX_HEAD_BYTES = 96 * 1024;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractLastTextBlock(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (!Array.isArray(content)) return null;

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || typeof block !== 'object') continue;
    const rawBlock = asRecord(block);
    if (
      (rawBlock.type === 'text' || rawBlock.type === 'input_text' || rawBlock.type === 'output_text') &&
      typeof rawBlock.text === 'string'
    ) {
      const trimmed = rawBlock.text.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function isCodexMessageEntry(entry: unknown): boolean {
  const rawEntry = asRecord(entry);
  const payload = asRecord(rawEntry.payload);
  if (rawEntry.type === 'event_msg' && payload.type === 'user_message') return true;
  if (rawEntry.type === 'response_item' && payload.type === 'message') return true;
  return false;
}

// Builds a preview (title, lastActivity, etc.) from an absolute JSONL path.
export async function getCodexPreviewFromNativePath(nativePath: string | null | undefined): Promise<{
  firstMessage: string;
  lastMessage: string;
  lastActivity: string;
  createdAt: string | null;
} | null> {
  if (!nativePath) return null;
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(nativePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) return null;

    const headSize = Math.min(CODEX_HEAD_BYTES, stats.size);
    const headBuf = Buffer.alloc(headSize);
    await fh.read(headBuf, 0, headSize, 0);
    await fh.close();
    fh = null;

    let firstUserMessage: string | null = null;
    let firstMessageTimestamp: string | null = null;

    for (const line of headBuf.toString('utf8').split('\n')) {
      const entry = parseCodexJsonlEntry(line);
      if (!entry) continue;
      const payload = asRecord(entry.payload);
      if (entry.type === 'event_msg' && payload.type === 'user_message') {
        if (typeof payload.message === 'string') firstUserMessage = payload.message;
      }
      if (!firstMessageTimestamp && isCodexMessageEntry(entry) && typeof entry.timestamp === 'string') {
        firstMessageTimestamp = entry.timestamp;
      }
    }

    const { lines } = await readJsonlTailLines(nativePath, 64 * 1024, 500);
    let lastTimestamp: string | null = null;
    let lastMessage: string | null = null;

    for (const raw of lines) {
      const entry = parseCodexJsonlEntry(raw);
      if (!entry) continue;
      const payload = asRecord(entry.payload);
      if (typeof entry.timestamp === 'string') lastTimestamp = entry.timestamp;
      if (entry.type === 'event_msg' && payload.type === 'user_message') {
        if (typeof payload.message === 'string' && payload.message.trim()) {
          lastMessage = payload.message.trim();
        }
      }
      if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const textContent =
          extractLastTextBlock(payload.content) ||
          (typeof payload.message === 'string' ? payload.message.trim() : null);
        if (textContent) lastMessage = textContent;
      }
    }

    return {
      firstMessage: firstUserMessage || 'Unknown Codex Session',
      lastMessage: lastMessage || '',
      lastActivity: lastTimestamp || new Date().toISOString(),
      createdAt: firstMessageTimestamp || null,
    };
  } catch (err) {
    logger.warn(`Could not build Codex preview from ${nativePath}:`, err);
    return null;
  } finally {
    await fh?.close();
  }
}
