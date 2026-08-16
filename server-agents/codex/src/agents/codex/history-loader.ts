// Path-based wrappers for Codex JSONL reading.
// Accepts absolute nativePath instead of scanning ~/.codex/sessions/.

import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import type { CodexJsonlNormalizationContext } from './history-normalizer.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '@garcon/server-agent-common/shared/native-message-source';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
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

// Rollout position, not wall-clock time, is the order Codex recorded. Timestamps
// repeat and run backwards within a turn, so sorting by them reordered rows against
// their own file - and the ledger persists whatever the importer returns, which
// would make that reordering permanent.
export function sortCodexMessagesBySource(messages: ChatMessage[]): ChatMessage[] {
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
  strict = false,
): void {
  const entry = strict ? parseStrictCodexJsonlEntry(line) : parseCodexJsonlEntry(line);
  if (!entry) return;
  try {
    const result = projection.project(entry, context);
    if (!result) return;
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
  } catch (error) {
    if (strict) throw error;
    return;
  }
}

function parseCodexJsonlEntry(line: string): Record<string, unknown> | null {
  const parsed = parseFirstJsonlValue<Record<string, unknown>>(line);
  return parsed.kind === 'value' ? asRecord(parsed.value) : null;
}

function parseStrictCodexJsonlEntry(line: string): Record<string, unknown> | null {
  const parsed = parseFirstJsonlValue<Record<string, unknown>>(line);
  if (parsed.kind === 'empty') return null;
  if (
    parsed.kind !== 'value'
    || parsed.discardedSuffix
    || !parsed.value
    || typeof parsed.value !== 'object'
    || Array.isArray(parsed.value)
  ) {
    throw new Error('Codex transcript record is invalid');
  }
  assertImportableCodexJsonlEntry(parsed.value);
  return parsed.value;
}

function assertImportableCodexJsonlEntry(entry: Record<string, unknown>): void {
  if (entry.type !== 'response_item') return;
  if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) {
    throw new Error('Codex response item is invalid');
  }
  const payload = entry.payload as Record<string, unknown>;
  if (payload.type !== 'message') return;
  if (
    (payload.role !== 'user' && payload.role !== 'assistant' && payload.role !== 'developer')
    || !Array.isArray(payload.content)
  ) {
    throw new Error('Codex response message is invalid');
  }
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
  return sortCodexMessagesBySource(messages);
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
      }, projection, options.throwOnError === true);
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
