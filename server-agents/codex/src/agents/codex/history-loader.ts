// Path-based wrappers for Codex JSONL reading.
// Accepts absolute nativePath instead of scanning ~/.codex/sessions/.

import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import type { CodexJsonlNormalizationContext } from './history-normalizer.js';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import { compareTranscriptTimestamps } from '@garcon/server-agent-common/shared/transcript-order';
import { LegacyCodexProjection } from './legacy-history-projection.js';
import { codexMessageSourceIdentity } from './message-source-identity.js';

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

function timestampMs(value: unknown): number {
  const time = new Date((value as string | number | Date | undefined) ?? 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function sortChatMessagesByTimestamp(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const left = new Date(a.message.timestamp || 0).getTime();
      const right = new Date(b.message.timestamp || 0).getTime();
      return compareTranscriptTimestamps(left, right) || a.index - b.index;
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
): boolean {
  const entry = parseCodexJsonlEntry(line);
  if (!entry) return false;
  try {
    const result = projection.project(entry, context);
    if (!result) return false;

    const identity = codexResponseItemIdentity(entry);
    let withinSourceOrdinal = 0;
    const appendMessages = (target: ChatMessage[], messages: ChatMessage[]): void => {
      for (const message of messages) {
        const sourceIdentity = codexMessageSourceIdentity({
          turnId: identity.turnId,
          itemId: identity.itemId,
          message,
          fallbackOrdinal: withinSourceOrdinal,
        });
        target.push(attachNativeMessageSource(message, {
          ...sourceIdentity,
          byteOffset: context.sourceByteOffset,
          lineNumber: context.sourceLineNumber,
          withinSourceOrdinal: sourceIdentity?.withinSourceOrdinal ?? withinSourceOrdinal,
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

function codexResponseItemIdentity(entry: Record<string, unknown>): {
  turnId?: string;
  itemId?: string;
} {
  if (entry.type !== 'response_item') return {};
  const payload = asRecord(entry.payload);
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  const turnId = typeof metadata.turn_id === 'string' ? metadata.turn_id.trim() : '';
  const itemId = typeof payload.id === 'string' ? payload.id.trim() : '';
  return {
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
  };
}

function finishCodexMessages(buckets: CodexMessageBuckets, includeFallback: boolean): ChatMessage[] {
  const messages = [...buckets.canonical];
  if (includeFallback && !buckets.hasCanonicalUser) messages.push(...buckets.fallbackUser);
  if (includeFallback && !buckets.hasCanonicalAssistant) messages.push(...buckets.fallbackAssistant);
  if (includeFallback && !buckets.hasCanonicalThinking) messages.push(...buckets.fallbackThinking);
  return sortChatMessagesByTimestamp(messages);
}

// Reads a Codex JSONL file and returns ChatMessage[].
// Uses per-content-class dedup. event_msg user messages are treated as
// canonical transcript content, while response_item user messages are
// only included as fallback when event_msg user entries are missing.
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
