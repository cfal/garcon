// Path-based wrappers for Codex JSONL reading.
// Accepts absolute nativePath instead of scanning ~/.codex/sessions/.

import { promises as fs } from 'fs';
import { readJsonlLineEntries, readJsonlTailLines } from '@garcon/server-agent-common/shared/history-loader-utils';
import {
  extractTextContent,
  type CodexJsonlNormalizationContext,
} from './history-normalizer.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '@garcon/server-agent-common/shared/native-message-source';
import type { ChatMessage } from '@garcon/common/chat-types';
import type {
  AgentLogger,
  AgentTranscriptPage,
  AgentTranscriptRevision,
} from '@garcon/server-agent-interface';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import {
  TranscriptRevisionAccumulator,
  transcriptRevision,
} from '@garcon/server-agent-common/lib/transcript-revision';
import { LegacyCodexProjection } from './legacy-history-projection.js';

const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface CodexMessageBuckets {
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
  order: number;
}

class BoundedLatestMessages {
  #items: OrderedMessage[] = [];
  #nextReplacementIndex = 0;

  constructor(private readonly limit: number) {}

  add(message: ChatMessage, order: number): void {
    if (this.limit === 0) return;
    const candidate = { message, order };
    if (this.#items.length < this.limit) {
      this.#items.push(candidate);
      return;
    }
    this.#items[this.#nextReplacementIndex] = candidate;
    this.#nextReplacementIndex = (this.#nextReplacementIndex + 1) % this.limit;
  }

  values(): OrderedMessage[] {
    return this.#items;
  }
}

function compareOrderedMessages(left: OrderedMessage, right: OrderedMessage): number {
  return left.order - right.order;
}

function sortCodexMessagesBySource(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const left = getNativeMessageRevisionSource(a.message);
      const right = getNativeMessageRevisionSource(b.message);
      if (left?.byteOffset !== undefined && right?.byteOffset !== undefined) {
        const byteOrder = left.byteOffset - right.byteOffset;
        if (byteOrder !== 0) return byteOrder;
      } else if (left?.lineNumber !== undefined && right?.lineNumber !== undefined) {
        const lineOrder = left.lineNumber - right.lineNumber;
        if (lineOrder !== 0) return lineOrder;
      }
      const ordinalOrder =
        (left?.withinSourceOrdinal ?? 0) - (right?.withinSourceOrdinal ?? 0);
      return ordinalOrder || a.index - b.index;
    })
    .map(({ message }) => message);
}

export function createCodexMessageBuckets(): CodexMessageBuckets {
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

export function addCodexJsonlLine(
  buckets: CodexMessageBuckets,
  line: string,
  context: CodexJsonlNormalizationContext = {},
  projection = new LegacyCodexProjection(),
): void {
  const entry = parseCodexJsonlEntry(line);
  if (!entry) return;
  try {
    const result = projection.project(entry, context);
    if (!result) return;
    const responseSource = codexResponseItemSource(entry);

    let withinSourceOrdinal = responseSource?.firstOrdinal ?? 0;
    const appendMessages = (target: ChatMessage[], messages: ChatMessage[]): void => {
      for (const message of messages) {
        target.push(attachNativeMessageSource(message, {
          entryId: responseSource?.entryId,
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
  } catch {
    return;
  }
}

function parseCodexJsonlEntry(line: string): Record<string, unknown> | null {
  const parsed = parseFirstJsonlValue<Record<string, unknown>>(line);
  return parsed.kind === 'value' ? asRecord(parsed.value) : null;
}

function codexResponseItemSource(
  entry: Record<string, unknown>,
): { entryId: string; firstOrdinal: number } | undefined {
  if (entry.type !== 'response_item') return undefined;
  const payload = asRecord(entry.payload);
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  const turnId = nonEmptyString(metadata.turn_id) ?? nonEmptyString(metadata.turnId);
  if (!turnId) return undefined;
  if (
    payload.type === 'custom_tool_call'
    || payload.type === 'custom_tool_call_output'
  ) {
    const itemId = nonEmptyString(payload.id) ?? customToolFallbackItemId(payload);
    if (!itemId) return undefined;
    return { entryId: `turn:${turnId}:item:${itemId}`, firstOrdinal: 0 };
  }
  if (
    payload.type === 'function_call'
    || payload.type === 'function_call_output'
  ) {
    const callId = nonEmptyString(payload.call_id);
    if (!callId) return undefined;
    // Codex command thread items use call_id for both the start and completed item:
    // https://github.com/openai/codex/blob/4c5fc230a9f35c24f863891e718e48377804ac9e/codex-rs/app-server-protocol/src/protocol/item_builders.rs#L96-L126
    return {
      entryId: `turn:${turnId}:item:${callId}`,
      firstOrdinal: payload.type.endsWith('_output') ? 1 : 0,
    };
  }
  const itemId = nonEmptyString(payload.id);
  if (!itemId) return undefined;
  // Codex carries response item IDs unchanged into non-command thread items:
  // https://github.com/openai/codex/blob/5d1fbf26c43abc65a203928b2e31561cb039e06d/codex-rs/core/src/event_mapping.rs#L176-L192
  return { entryId: `turn:${turnId}:item:${itemId}`, firstOrdinal: 0 };
}

function customToolFallbackItemId(payload: Record<string, unknown>): string | null {
  const callId = nonEmptyString(payload.call_id);
  return callId ? `raw:${String(payload.type)}:${callId}` : null;
}

function finishCodexMessages(buckets: CodexMessageBuckets, includeFallback: boolean): ChatMessage[] {
  const messages = [...buckets.canonical];
  if (includeFallback && !buckets.hasCanonicalUser) messages.push(...buckets.fallbackUser);
  if (includeFallback && !buckets.hasCanonicalAssistant) messages.push(...buckets.fallbackAssistant);
  if (includeFallback && !buckets.hasCanonicalThinking) messages.push(...buckets.fallbackThinking);
  return sortCodexMessagesBySource(messages);
}

async function scanCodexMessagePage(
  nativePath: string,
  windowSize: number,
  signal?: AbortSignal,
): Promise<{
  summary: CodexMessageSummary;
  messages: ChatMessage[];
  revision: AgentTranscriptRevision;
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
  let sourceOrder = 0;
  const projection = new LegacyCodexProjection();

  for await (const entry of readJsonlLineEntries(nativePath, { signal })) {
    const buckets = createCodexMessageBuckets();
    addCodexJsonlLine(buckets, entry.line, {
      sourceByteOffset: entry.byteOffset,
      sourceLineNumber: entry.lineNumber,
    }, projection);
    for (const name of bucketNames) {
      for (const message of buckets[name]) {
        windows[name].add(message, sourceOrder);
        sourceOrder += 1;
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
  const combined = includedNames.flatMap((name) => windows[name].values());
  combined.sort(compareOrderedMessages);
  const revision = new TranscriptRevisionAccumulator();
  for (const name of includedNames) revision.merge(revisions[name]);
  return {
    summary,
    messages: combined.slice(-Math.min(summary.total, windowSize)).map((entry) => entry.message),
    revision: revision.finish(),
  };
}

// Reads a Codex JSONL file and returns ChatMessage[].
// Uses message-class source precedence. event_msg user messages are canonical,
// while response_item user messages are included only when that class is absent.
export async function loadCodexChatMessages(
  nativePath: string | null | undefined,
  logger: AgentLogger = NOOP_LOGGER,
  options: { readonly throwOnError?: boolean; readonly signal?: AbortSignal } = {},
): Promise<ChatMessage[]> {
  if (!nativePath) return [];

  try {
    const buckets = createCodexMessageBuckets();
    const projection = new LegacyCodexProjection();

    for await (const entry of readJsonlLineEntries(nativePath, { signal: options.signal })) {
      addCodexJsonlLine(buckets, entry.line, {
        sourceByteOffset: entry.byteOffset,
        sourceLineNumber: entry.lineNumber,
      }, projection);
    }

    return finishCodexMessages(buckets, true);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (options.throwOnError) throw error;
    logger.error('Codex transcript load failed', {
      nativePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function loadCodexChatMessagePage(
  nativePath: string | null | undefined,
  limit: number,
  offset: number,
  logger: AgentLogger = NOOP_LOGGER,
  signal?: AbortSignal,
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
    // Retains the newest offset + limit messages in physical rollout order.
    const windowSize = offset + limit;
    signal?.throwIfAborted();
    const scan = await scanCodexMessagePage(nativePath, windowSize, signal);
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
    signal?.throwIfAborted();
    logger.warn('Codex transcript page load failed', {
      nativePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function pageFromMessages(
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
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
export async function getCodexPreviewFromNativePath(
  nativePath: string | null | undefined,
  logger: AgentLogger = NOOP_LOGGER,
  signal?: AbortSignal,
): Promise<{
  firstMessage: string;
  lastMessage: string;
  lastActivity: string;
  createdAt: string | null;
} | null> {
  if (!nativePath) return null;
  let fh: fs.FileHandle | null = null;
  try {
    signal?.throwIfAborted();
    fh = await fs.open(nativePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) return null;

    const headSize = Math.min(CODEX_HEAD_BYTES, stats.size);
    const headBuf = Buffer.alloc(headSize);
    await fh.read(headBuf, 0, headSize, 0);
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    logger.warn('Codex transcript preview load failed', {
      nativePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await fh?.close();
  }
}
