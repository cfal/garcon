import { promises as fs } from 'fs';
import path from 'path';
import {
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { convertFactoryToolUse } from './tool-use-converter.js';
import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { attachNativeMessageSource, type NativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { hasNodeErrorCode } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  getFactorySessionDiscoveryIndexPath,
  getFactorySessionsRoot,
} from './factory-paths.js';
import {
  convertFactoryAssistantText,
  isFactorySystemReminderText,
} from './factory-text.js';

const SILENT_LOGGER: AgentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};

export interface FactorySessionDiscoveryEntry {
  createdTimeMs?: number;
  cwd?: string;
  id: string;
  messageCount?: number;
  modifiedTimeMs?: number;
  sessionPath?: string;
  sessionTitle?: string;
  title?: string;
}

interface FactorySessionDiscoveryIndex {
  entries?: Record<string, FactorySessionDiscoveryEntry>;
}

interface FactorySessionStartEvent {
  id?: string;
  sessionTitle?: string;
  timestamp?: number | string;
  title?: string;
  type: 'session_start';
}

interface FactoryToolUsePart {
  id?: string;
  input?: Record<string, unknown>;
  name?: string;
  parameters?: Record<string, unknown>;
  toolId?: string;
  toolName?: string;
  type: string;
}

interface FactoryToolResultPart {
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
  toolUseID?: string;
  type: string;
  value?: unknown;
}

interface FactoryTextPart {
  text?: string;
  thinking?: string;
  type: string;
}

type FactoryContentPart = FactoryTextPart | FactoryToolUsePart | FactoryToolResultPart;

interface FactoryStoredChatMessage {
  content?: FactoryContentPart[];
  role?: string;
  visibility?: string;
}

interface FactoryStoredMessageEvent {
  message?: FactoryStoredChatMessage;
  timestamp?: number | string;
  type: 'message';
  visibility?: string;
}

export type FactoryStoredEvent = FactorySessionStartEvent | FactoryStoredMessageEvent;

export interface FactoryStoredEventWithSource {
  event: FactoryStoredEvent;
  source?: NativeMessageSource;
}

export type FactoryStoredEventInput = FactoryStoredEvent | FactoryStoredEventWithSource;

export interface FactoryPreview {
  createdAt: string | null;
  firstMessage: string;
  lastActivity: string | null;
  lastMessage: string;
}

interface FactoryPreviewFallback {
  createdAt?: string | null;
  lastActivity?: string | null;
  title?: string;
}

function toIsoString(value: number | string | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

async function readFactorySessionDiscoveryIndex(
  signal?: AbortSignal,
): Promise<FactorySessionDiscoveryIndex> {
  try {
    return await readFactorySessionDiscoveryIndexStrict(signal);
  } catch {
    signal?.throwIfAborted();
    return {};
  }
}

async function readFactorySessionDiscoveryIndexStrict(
  signal?: AbortSignal,
): Promise<FactorySessionDiscoveryIndex> {
  signal?.throwIfAborted();
  let raw: string;
  try {
    raw = await fs.readFile(getFactorySessionDiscoveryIndexPath(), 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return {};
    throw error;
  }
  signal?.throwIfAborted();
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Factory session discovery index is invalid');
  }
  const entries = (parsed as Record<string, unknown>).entries;
  if (entries !== undefined && (!entries || typeof entries !== 'object' || Array.isArray(entries))) {
    throw new Error('Factory session discovery index entries are invalid');
  }
  return parsed as FactorySessionDiscoveryIndex;
}

async function findFileWithSuffix(
  dir: string,
  suffix: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return await findFileWithSuffixStrict(dir, suffix, signal);
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function findFileWithSuffixStrict(
  dir: string,
  suffix: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (!dir || !suffix) return null;

  if (typeof Bun !== 'undefined' && typeof Bun.Glob === 'function') {
    try {
      const escapedSuffix = suffix
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?');
      const glob = new Bun.Glob(`**/*${escapedSuffix}`);
      let match: string | null = null;
      for await (const filePath of glob.scan({
        absolute: true,
        cwd: dir,
        followSymlinks: false,
        onlyFiles: true,
      })) {
        signal?.throwIfAborted();
        if (match) throw new Error('Factory transcript discovery found duplicate session files');
        match = filePath;
      }
      return match;
    } catch (error) {
      signal?.throwIfAborted();
      if (hasNodeErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    signal?.throwIfAborted();
    if (hasNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }

  let match: string | null = null;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await findFileWithSuffixStrict(fullPath, suffix, signal);
      if (!nested) continue;
      if (match) throw new Error('Factory transcript discovery found duplicate session files');
      match = nested;
      continue;
    }
    if (!entry.name.endsWith(suffix)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Factory transcript source is not a regular file');
    }
    if (match) throw new Error('Factory transcript discovery found duplicate session files');
    match = fullPath;
  }

  return match;
}

export async function getFactorySessionDiscoveryEntry(
  sessionId: string,
  signal?: AbortSignal,
): Promise<FactorySessionDiscoveryEntry | null> {
  signal?.throwIfAborted();
  if (!sessionId) return null;
  const index = await readFactorySessionDiscoveryIndex(signal);
  signal?.throwIfAborted();
  return index.entries?.[sessionId] ?? null;
}

async function getFactorySessionDiscoveryEntryStrict(
  sessionId: string,
  signal?: AbortSignal,
): Promise<FactorySessionDiscoveryEntry | null> {
  signal?.throwIfAborted();
  if (!sessionId) return null;
  const index = await readFactorySessionDiscoveryIndexStrict(signal);
  signal?.throwIfAborted();
  const entry = index.entries?.[sessionId];
  if (entry === undefined) return null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Factory session discovery entry is invalid');
  }
  if (
    entry.sessionPath !== undefined
    && (typeof entry.sessionPath !== 'string' || !entry.sessionPath)
  ) {
    throw new Error('Factory session discovery path is invalid');
  }
  return entry;
}

export async function findFactorySessionFileBySessionId(
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (!sessionId) return null;

  const discoveryEntry = await getFactorySessionDiscoveryEntry(sessionId, signal);
  if (discoveryEntry?.sessionPath) {
    try {
      await fs.access(discoveryEntry.sessionPath);
      signal?.throwIfAborted();
      return discoveryEntry.sessionPath;
    } catch {
      signal?.throwIfAborted();
      // Falls back to scanning because Factory's discovery index can lag moves.
    }
  }

  return findFileWithSuffix(getFactorySessionsRoot(), `${sessionId}.jsonl`, signal);
}

export async function findFactorySessionFileBySessionIdStrict(
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (!sessionId) return null;

  const discoveryEntry = await getFactorySessionDiscoveryEntryStrict(sessionId, signal);
  if (discoveryEntry?.sessionPath) {
    try {
      await fs.access(discoveryEntry.sessionPath);
      signal?.throwIfAborted();
      return discoveryEntry.sessionPath;
    } catch (error) {
      signal?.throwIfAborted();
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
    }
  }

  return findFileWithSuffixStrict(getFactorySessionsRoot(), `${sessionId}.jsonl`, signal);
}

async function readFactorySessionEvents(
  sessionPath: string,
  logger: AgentLogger,
  throwOnError = false,
): Promise<FactoryStoredEventWithSource[]> {
  const events: FactoryStoredEventWithSource[] = [];

  for await (const entry of readJsonlLineEntries(sessionPath)) {
    try {
      const event = JSON.parse(entry.line) as FactoryStoredEvent;
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
        if (throwOnError) throw new Error('Factory transcript record is invalid');
        continue;
      }
      events.push({
        event,
        source: {
          ...(event.type === 'session_start' && event.id ? { entryId: event.id } : {}),
          lineNumber: entry.lineNumber,
          byteOffset: entry.byteOffset,
        },
      });
    } catch (error) {
      if (throwOnError) throw error;
      logger.warn('Factory transcript contains invalid JSON.', {
        sessionPath,
        lineNumber: entry.lineNumber ?? null,
      });
    }
  }

  return events;
}

function isFactoryStoredEventWithSource(input: FactoryStoredEventInput): input is FactoryStoredEventWithSource {
  return Boolean(input)
    && typeof input === 'object'
    && 'event' in input
    && Boolean((input as FactoryStoredEventWithSource).event);
}

function normalizeFactoryStoredEventInput(input: FactoryStoredEventInput): FactoryStoredEventWithSource {
  return isFactoryStoredEventWithSource(input)
    ? input
    : { event: input as FactoryStoredEvent };
}

function getVisibleUserTextParts(content: FactoryContentPart[]): string[] {
  return content
    .filter((part): part is FactoryTextPart & { text: string } =>
      part.type === 'text' && 'text' in part && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0 && !isFactorySystemReminderText(text));
}

function getMessageTimestamp(event: FactoryStoredMessageEvent): string {
  return toIsoString(event.timestamp) ?? new Date().toISOString();
}

function isHiddenFactoryMessage(event: FactoryStoredMessageEvent): boolean {
  return event.visibility === 'llm_only' || event.message?.visibility === 'llm_only';
}

function pushMessages(
  messages: ChatMessage[],
  source: NativeMessageSource | undefined,
  nextMessages: ChatMessage[],
  startOrdinal: number,
): number {
  nextMessages.forEach((message, index) => {
    messages.push(attachNativeMessageSource(message, {
      ...source,
      withinSourceOrdinal: startOrdinal + index,
    }));
  });
  return startOrdinal + nextMessages.length;
}

export function loadFactoryChatMessagesFromEvents(events: FactoryStoredEventInput[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const input of events) {
    const { event, source } = normalizeFactoryStoredEventInput(input);
    if (event.type !== 'message' || !event.message) continue;
    if (isHiddenFactoryMessage(event)) continue;

    const timestamp = getMessageTimestamp(event);
    const role = event.message.role;
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    let sourceOrdinal = 0;

    if (role === 'user') {
      for (const part of content) {
        if (part.type !== 'tool_result') continue;
        const toolUseId = (part as FactoryToolResultPart).tool_use_id || (part as FactoryToolResultPart).toolUseID || '';
        const rawValue = (part as FactoryToolResultPart).value ?? (part as FactoryToolResultPart).content;
        sourceOrdinal = pushMessages(messages, source, [
          new ToolResultMessage(
            timestamp,
            toolUseId,
            normalizeToolResultContent(rawValue),
            Boolean((part as FactoryToolResultPart).is_error),
          ),
        ], sourceOrdinal);
      }

      const text = getVisibleUserTextParts(content).join('\n');
      if (text) {
        pushMessages(messages, source, [
          new UserMessage(timestamp, stripResolvedFileMentionContext(text)),
        ], sourceOrdinal);
      }
      continue;
    }

    if (role === 'assistant') {
      for (const part of content) {
        if (part.type === 'thinking' && typeof (part as FactoryTextPart).thinking === 'string') {
          sourceOrdinal = pushMessages(messages, source, [
            new ThinkingMessage(timestamp, (part as FactoryTextPart).thinking!),
          ], sourceOrdinal);
        } else if (part.type === 'text' && typeof (part as FactoryTextPart).text === 'string') {
          sourceOrdinal = pushMessages(
            messages,
            source,
            convertFactoryAssistantText(timestamp, (part as FactoryTextPart).text!),
            sourceOrdinal,
          );
        } else if (part.type === 'tool_use') {
          sourceOrdinal = pushMessages(messages, source, [
            convertFactoryToolUse(timestamp, part as FactoryToolUsePart),
          ], sourceOrdinal);
        }
      }
    }
  }

  return messages;
}

export function factoryStoredEventActivityTimestamp(value: unknown): string | null | undefined {
  if (!isFactoryStoredEvent(value)) return undefined;
  if (loadFactoryChatMessagesFromEvents([value]).length === 0) return undefined;
  return toIsoString(value.timestamp);
}

function isFactoryStoredEvent(value: unknown): value is FactoryStoredEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  return type === 'session_start' || type === 'message';
}

export async function loadFactoryChatMessages(
  sessionPath: string,
  logger: AgentLogger = SILENT_LOGGER,
  options: { readonly throwOnError?: boolean } = {},
): Promise<ChatMessage[]> {
  try {
    const events = await readFactorySessionEvents(sessionPath, logger, options.throwOnError);
    return loadFactoryChatMessagesFromEvents(events);
  } catch (error) {
    if (options.throwOnError) throw error;
    logger.warn('Factory transcript loading failed.', {
      sessionPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function loadFactoryChatMessagesBySessionId(
  sessionId: string,
  logger: AgentLogger = SILENT_LOGGER,
): Promise<ChatMessage[]> {
  const sessionPath = await findFactorySessionFileBySessionId(sessionId);
  if (!sessionPath) return [];
  return loadFactoryChatMessages(sessionPath, logger);
}

function getPreviewText(message: ChatMessage): string {
  if (message.type === 'assistant-message' || message.type === 'user-message') {
    return message.content;
  }
  return '';
}

function buildFallbackPreview(fallback: FactoryPreviewFallback): FactoryPreview {
  const title = fallback.title || 'Unknown Factory Session';
  return {
    createdAt: fallback.createdAt ?? null,
    firstMessage: title,
    lastActivity: fallback.lastActivity ?? null,
    lastMessage: title,
  };
}

export async function getFactoryPreviewFromSessionPath(
  sessionPath: string,
  fallback: FactoryPreviewFallback = {},
  logger: AgentLogger = SILENT_LOGGER,
): Promise<FactoryPreview | null> {
  if (!sessionPath) return null;

  try {
    const events = await readFactorySessionEvents(sessionPath, logger);
    const messages = loadFactoryChatMessagesFromEvents(events);
    const sessionStart = events
      .map((entry) => entry.event)
      .find((event): event is FactorySessionStartEvent => event.type === 'session_start');
    const visibleMessages = messages.filter((message) => message.type === 'assistant-message' || message.type === 'user-message');
    const firstMessage = visibleMessages.find((message) => message.type === 'user-message');
    const lastMessage = [...visibleMessages].reverse().find((message) => message.type === 'assistant-message' || message.type === 'user-message');
    const lastActivity = [...messages].reverse().find((message) => typeof message.timestamp === 'string');
    const title = sessionStart?.sessionTitle || sessionStart?.title || fallback.title || 'Unknown Factory Session';

    return {
      createdAt: fallback.createdAt ?? toIsoString(sessionStart?.timestamp),
      firstMessage: firstMessage ? firstMessage.content : title,
      lastActivity: lastActivity?.timestamp || fallback.lastActivity || null,
      lastMessage: lastMessage ? getPreviewText(lastMessage) : title,
    };
  } catch (error) {
    logger.warn('Factory transcript preview failed.', {
      sessionPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return Object.keys(fallback).length > 0 ? buildFallbackPreview(fallback) : null;
  }
}

export async function getFactoryPreviewFromSessionId(
  sessionId: string,
  logger: AgentLogger = SILENT_LOGGER,
): Promise<FactoryPreview | null> {
  if (!sessionId) return null;

  const [discoveryEntry, sessionPath] = await Promise.all([
    getFactorySessionDiscoveryEntry(sessionId),
    findFactorySessionFileBySessionId(sessionId),
  ]);

  if (!sessionPath && !discoveryEntry) return null;

  const fallback = {
    createdAt: toIsoString(discoveryEntry?.createdTimeMs),
    lastActivity: toIsoString(discoveryEntry?.modifiedTimeMs),
    title: discoveryEntry?.sessionTitle || discoveryEntry?.title || 'Unknown Factory Session',
  };

  if (!sessionPath) {
    return buildFallbackPreview(fallback);
  }

  return getFactoryPreviewFromSessionPath(sessionPath, fallback, logger);
}
