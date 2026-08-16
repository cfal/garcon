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
import { extractCompactionSummary, parseCompactMetadata } from './compaction.js';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { attachNativeMessageSource, getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { deterministicTranscriptTimestamp } from '@garcon/server-agent-common/shared/transcript-timestamp';
import { compareTranscriptTimestamps } from '@garcon/server-agent-common/shared/transcript-order';
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
  return asRecord(entry.origin).kind === 'task-notification' || isSystemUserMessage(text);
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

// Microcompaction re-appends retained entries with their original uuids and
// content, differing only in parent rechaining, so the first occurrence is the
// canonical one and later copies must not render again.
function dedupeClaudeEntriesByUuid(
  entries: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seenUuids = new Set<string>();
  return entries.filter((entry) => {
    const uuid = asString(entry.uuid);
    if (!uuid) return true;
    if (seenUuids.has(uuid)) return false;
    seenUuids.add(uuid);
    return true;
  });
}

export function convertClaudeEntries(rawEntries: Record<string, unknown>[]): ChatMessage[] {
  const entries = dedupeClaudeEntriesByUuid(rawEntries);
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
  // reordered by the chronological sort, so collect boundary metadata up front and
  // pair it FIFO with the summaries rather than relying on boundary-before-summary order.
  const compactions = entries
    .filter((entry) => entry.type === 'system' && entry.subtype === 'compact_boundary')
    .map((entry) => parseCompactMetadata(entry.compactMetadata ?? entry.compact_metadata));
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

    const queuedPrompts = queuedCommandPrompts(entry);
    if (queuedPrompts.length > 0) {
      const attachmentTimestamp = asString(asRecord(entry.attachment).timestamp);
      for (const prompt of queuedPrompts) {
        pushMessage(entry, userMessage(entry, attachmentTimestamp || ts, prompt));
      }
      continue;
    }

    if (entry.type === 'attachment') continue;

    if (entry.type === 'system') continue;

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
    const raw = await fs.readFile(nativePath, 'utf8');
    return parseClaudeJsonlLines(raw.split('\n'));
  } catch (error) {
    if (options.throwOnError) throw error;
    logger.error('Claude transcript load failed', {
      nativePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
