// Path-based wrappers for Claude JSONL reading.
// Accepts absolute nativePath instead of (projectName, agentSessionId).

import { promises as fs } from 'fs';
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
import { claudeToolResultContent } from './tool-result-converter.js';
import { extractCompactionSummary, parseCompactMetadata, type CompactionInfo } from './compaction.js';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { attachNativeMessageSource, getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { deterministicTranscriptTimestamp } from '@garcon/server-agent-common/shared/transcript-timestamp';
import { compareTranscriptTimestamps } from '@garcon/server-agent-common/shared/transcript-order';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { claudeSteeringInputsFromNativeContent } from './user-input.js';

const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

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

interface ClaudeUserText {
  readonly text: string;
  readonly steering: boolean;
}

function claudeUserTexts(content: unknown): readonly ClaudeUserText[] {
  const steeringInputs = claudeSteeringInputsFromNativeContent(content);
  if (steeringInputs) {
    return steeringInputs
      .filter((text) => text.trim().length > 0)
      .map((text) => ({ text, steering: true }));
  }
  const text = getMessageText(content);
  return text ? [{ text, steering: false }] : [];
}

function isSystemUserMessage(text: string): boolean {
  return (
    text.startsWith('<command-name>') ||
    text.startsWith('<command-message>') ||
    text.startsWith('<command-args>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<system-reminder>') ||
    text.startsWith('<task-notification>') ||
    text.startsWith('Caveat:') ||
    text.startsWith('This session is being continued from a previous') ||
    text.startsWith('Invalid API key') ||
    text.includes('{"subtasks":') ||
    text.includes('CRITICAL: You MUST respond with ONLY a JSON') ||
    text === 'Warmup'
  );
}

function isProviderOwnedUserMessage(
  entry: Record<string, unknown>,
  text: string,
): boolean {
  const originKind = asRecord(entry.origin).kind;
  // The SDK classifies every present origin except "human" as provider-injected, including future kinds.
  // https://github.com/anthropics/claude-agent-sdk-python/blob/99a734c94ff4f41e08a9edb05371003538a366b2/src/claude_agent_sdk/types.py#L1049-L1120
  return (
    typeof originKind === 'string' && originKind !== 'human'
  ) || isSystemUserMessage(text);
}

function queuedCommandPrompts(entry: Record<string, unknown>): readonly string[] {
  if (entry.type !== 'attachment') return [];
  const attachment = asRecord(entry.attachment);
  if (attachment.type !== 'queued_command' || attachment.commandMode !== 'prompt') return [];
  return claudeUserTexts(attachment.prompt)
    .filter((prompt) => prompt.steering || !isProviderOwnedUserMessage(entry, prompt.text))
    .map((prompt) => stripResolvedFileMentionContext(prompt.text));
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

interface ClaudeSortKey {
  readonly entry: Record<string, unknown>;
  readonly index: number;
  readonly time: number;
}

function claudeSortKey(entry: Record<string, unknown>, index: number): ClaudeSortKey {
  return { entry, index, time: timestampMs(entry.timestamp) };
}

function compareClaudeSortKeys(a: ClaudeSortKey, b: ClaudeSortKey): number {
  return compareTranscriptTimestamps(a.time, b.time) || a.index - b.index;
}

export function sortClaudeEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries.map(claudeSortKey).sort(compareClaudeSortKeys).map(({ entry }) => entry);
}

// The sort itself stays one call: a transcript is appended in time order, so
// sorting it is close to linear.
export async function sortClaudeEntriesInSteps(
  entries: readonly Record<string, unknown>[],
  steps: EventLoopSteps,
): Promise<Record<string, unknown>[]> {
  const keys: ClaudeSortKey[] = [];
  await steps.forEach(entries, (entry) => { keys.push(claudeSortKey(entry, keys.length)); });
  keys.sort(compareClaudeSortKeys);
  const sorted: Record<string, unknown>[] = [];
  await steps.forEach(keys, ({ entry }) => { sorted.push(entry); });
  return sorted;
}

// Keeps the first occurrence of each entry and collects compaction boundaries,
// which conversion pairs with their summaries. Microcompaction re-appends
// retained entries with their original uuids and content, differing only in
// parent rechaining, so the first occurrence is the canonical one and later
// copies must not render again.
function collectClaudeEntries(): {
  readonly entries: Record<string, unknown>[];
  readonly compactions: CompactionInfo[];
  add(entry: Record<string, unknown>): void;
} {
  const seenUuids = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  const compactions: CompactionInfo[] = [];
  return {
    entries,
    compactions,
    add(entry) {
      const uuid = asString(entry.uuid);
      if (uuid && seenUuids.has(uuid)) return;
      if (uuid) seenUuids.add(uuid);
      entries.push(entry);
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        compactions.push(parseCompactMetadata(entry.compactMetadata ?? entry.compact_metadata));
      }
    },
  };
}

export function convertClaudeEntries(rawEntries: Record<string, unknown>[]): ChatMessage[] {
  const collected = collectClaudeEntries();
  for (const entry of rawEntries) collected.add(entry);
  const converter = createClaudeEntryConverter(collected.compactions);
  for (const entry of collected.entries) converter.convert(entry);
  return converter.messages;
}

export async function convertClaudeEntriesInSteps(
  rawEntries: readonly Record<string, unknown>[],
  steps: EventLoopSteps,
): Promise<ChatMessage[]> {
  const collected = collectClaudeEntries();
  await steps.forEach(rawEntries, collected.add);
  const converter = createClaudeEntryConverter(collected.compactions);
  await steps.forEach(collected.entries, converter.convert);
  return converter.messages;
}

function createClaudeEntryConverter(compactions: readonly CompactionInfo[]): {
  readonly messages: ChatMessage[];
  convert(entry: Record<string, unknown>): void;
} {
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

  function userMessage(
    entry: Record<string, unknown>,
    timestamp: string,
    content: string,
  ): UserMessage {
    const upstreamRequestId = getNativeMessageSource(entry)?.entryId;
    return new UserMessage(
      timestamp,
      content,
      undefined,
      upstreamRequestId ? { upstreamRequestId } : undefined,
    );
  }

  // A compact_boundary and its summary carry near-identical timestamps and can be
  // reordered by the chronological sort, so boundary metadata is collected up front and
  // paired FIFO with the summaries rather than relying on boundary-before-summary order.
  let compactionIndex = 0;

  function convert(entry: Record<string, unknown>): void {
    const source = getNativeMessageSource(entry);
    const ts = asString(entry.timestamp)
      || deterministicTranscriptTimestamp(source?.lineNumber, source?.byteOffset);
    const message = asRecord(entry.message);

    if (entry.type === 'progress' || entry.type === 'queue-operation' ||
      entry.type === 'file-history-snapshot' || entry.type === 'summary') {
      return;
    }

    const queuedPrompts = queuedCommandPrompts(entry);
    if (queuedPrompts.length > 0) {
      const attachmentTimestamp = asString(asRecord(entry.attachment).timestamp);
      for (const prompt of queuedPrompts) {
        pushMessage(entry, userMessage(entry, attachmentTimestamp || ts, prompt));
      }
      return;
    }

    if (entry.type === 'attachment') return;

    if (entry.type === 'system') return;

    if (entry.isCompactSummary) {
      const summaryText = getMessageText(message.content);
      if (summaryText) {
        const info = compactions[compactionIndex++] ?? { trigger: 'manual' as const };
        const compactionMessage = new CompactionMessage(
          ts,
          info.trigger,
          extractCompactionSummary(summaryText),
          info.preTokens,
          info.postTokens,
        );
        pushMessage(entry, compactionMessage);
      }
      return;
    }

    if (entry.isMeta) return;

    if (entry.isApiErrorMessage) {
      const errorText = entry.error
        ? (typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error))
        : getMessageText(message.content) || 'API error';
      pushMessage(entry, new ErrorMessage(ts, errorText));
      return;
    }

    if (message.role === 'user') {
      const content = message.content;

      if (Array.isArray(content)) {
        for (const rawPart of content) {
          const part = asRecord(rawPart);
          if (part.type === 'tool_result') {
            pushMessage(entry, new ToolResultMessage(
              ts,
              asString(part.tool_use_id) || '',
              claudeToolResultContent(part.content, entry.toolUseResult ?? entry.tool_use_result),
              Boolean(part.is_error),
            ));
          }
        }
      }

      for (const userText of claudeUserTexts(content)) {
        if (userText.steering || !isProviderOwnedUserMessage(entry, userText.text)) {
          pushMessage(entry, userMessage(
            entry,
            ts,
            stripResolvedFileMentionContext(userText.text),
          ));
        }
      }
      return;
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
      return;
    }

    if (entry.type === 'thinking' && message.content) {
      const thinkContent = typeof message.content === 'string'
        ? message.content : '';
      if (thinkContent) {
        pushMessage(entry, new ThinkingMessage(ts, thinkContent));
      }
    }
  }

  return { messages, convert };
}

// Parses each line as its 64 KiB chunk arrives. Conversion needs the complete chronological
// order and runs after, continuing the same time-bounded steps.
async function parseClaudeJsonlFile(nativePath: string, strict: boolean): Promise<ChatMessage[]> {
  const steps = new EventLoopSteps('claude-history-load');
  const entries: Record<string, unknown>[] = [];
  for await (const { line, lineNumber } of readJsonlLineEntries(nativePath)) {
    const entry = strict
      ? parseStrictClaudeJsonlEntryWithSource(line, lineNumber!)
      : parseClaudeJsonlEntryWithSource(line, lineNumber!);
    if (entry) entries.push(entry);
    if (steps.due) await steps.next();
  }
  return convertClaudeEntriesInSteps(await sortClaudeEntriesInSteps(entries, steps), steps);
}

function parseStrictClaudeJsonlEntryWithSource(
  line: string,
  lineNumber: number,
): Record<string, unknown> | null {
  const parsed = parseFirstJsonlValue<Record<string, unknown>>(line);
  if (parsed.kind === 'empty') return null;
  if (parsed.kind !== 'value' || parsed.discardedSuffix) {
    throw new Error(`Claude transcript record ${lineNumber} is invalid`);
  }
  const entry = asRecord(parsed.value);
  if (!entry.sessionId) return null;
  assertImportableClaudeEntry(entry, lineNumber);
  const entryId = asString(entry.uuid) || asString(entry.id) || asString(entry.messageId);
  return attachNativeMessageSource(entry, {
    lineNumber,
    ...(entryId ? { entryId } : {}),
  });
}

function assertImportableClaudeEntry(
  entry: Record<string, unknown>,
  lineNumber: number,
): void {
  if (entry.type !== 'user' && entry.type !== 'assistant') return;
  if (!entry.message || typeof entry.message !== 'object' || Array.isArray(entry.message)) {
    throw new Error(`Claude transcript record ${lineNumber} has an invalid message`);
  }
  const message = entry.message as Record<string, unknown>;
  if (
    message.role !== entry.type
    || !('content' in message)
    || (typeof message.content !== 'string' && !Array.isArray(message.content))
  ) {
    throw new Error(`Claude transcript record ${lineNumber} has an invalid message`);
  }
  if (!Array.isArray(message.content)) return;
  for (const rawPart of message.content) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      throw new Error(`Claude transcript record ${lineNumber} has an invalid message part`);
    }
    const part = rawPart as Record<string, unknown>;
    if (
      typeof part.type !== 'string'
      || !part.type
      || (part.type === 'text' && typeof part.text !== 'string')
      || (part.type === 'thinking' && typeof part.thinking !== 'string')
    ) {
      throw new Error(`Claude transcript record ${lineNumber} has an invalid message part`);
    }
  }
}

// Reads a Claude JSONL file and returns ChatMessage[].
export async function loadClaudeChatMessages(
  nativePath: string | null | undefined,
  logger: AgentLogger = NOOP_LOGGER,
  options: { readonly throwOnError?: boolean } = {},
): Promise<ChatMessage[]> {
  if (!nativePath) return [];
  try {
    await fs.access(nativePath);
  } catch (error) {
    if (options.throwOnError) throw error;
    return [];
  }

  try {
    return await parseClaudeJsonlFile(nativePath, options.throwOnError === true);
  } catch (error) {
    if (options.throwOnError) throw error;
    logger.error('Claude transcript load failed', {
      nativePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
