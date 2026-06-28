import { promises as fs } from 'fs';
import path from 'path';
import {
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { convertFactoryToolUse } from './tool-use-converter.js';
import { normalizeToolResultContent } from '../shared/normalize-util.js';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.js';
import { readJsonlLineEntries } from '../shared/history-loader-utils.ts';
import { attachNativeSourceToMessages, type NativeMessageSource } from '../shared/native-message-source.js';
import { createLogger } from '../../lib/log.js';
import {
  getFactorySessionDiscoveryIndexPath,
  getFactorySessionsRoot,
} from './factory-paths.js';
import {
  convertFactoryAssistantText,
  isFactorySystemReminderText,
} from './factory-text.js';

const logger = createLogger('agents:factory:history-loader');

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

type FactoryStoredEvent = FactorySessionStartEvent | FactoryStoredMessageEvent;

interface FactoryStoredEventWithSource {
  event: FactoryStoredEvent;
  source?: NativeMessageSource;
}

type FactoryStoredEventInput = FactoryStoredEvent | FactoryStoredEventWithSource;

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

async function readFactorySessionDiscoveryIndex(): Promise<FactorySessionDiscoveryIndex> {
  try {
    const raw = await fs.readFile(getFactorySessionDiscoveryIndexPath(), 'utf8');
    return JSON.parse(raw) as FactorySessionDiscoveryIndex;
  } catch {
    return {};
  }
}

async function findFileWithSuffix(dir: string, suffix: string): Promise<string | null> {
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
      for await (const filePath of glob.scan({
        absolute: true,
        cwd: dir,
        followSymlinks: false,
        onlyFiles: true,
      })) {
        return filePath;
      }
    } catch {
      return null;
    }
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await findFileWithSuffix(fullPath, suffix);
      if (nested) return nested;
      continue;
    }
    if (entry.name.endsWith(suffix)) return fullPath;
  }

  return null;
}

export async function getFactorySessionDiscoveryEntry(sessionId: string): Promise<FactorySessionDiscoveryEntry | null> {
  if (!sessionId) return null;
  const index = await readFactorySessionDiscoveryIndex();
  return index.entries?.[sessionId] ?? null;
}

export async function findFactorySessionFileBySessionId(sessionId: string): Promise<string | null> {
  if (!sessionId) return null;

  const discoveryEntry = await getFactorySessionDiscoveryEntry(sessionId);
  if (discoveryEntry?.sessionPath) {
    try {
      await fs.access(discoveryEntry.sessionPath);
      return discoveryEntry.sessionPath;
    } catch {
      // Falls back to scanning because Factory's discovery index can lag moves.
    }
  }

  return findFileWithSuffix(getFactorySessionsRoot(), `${sessionId}.jsonl`);
}

async function readFactorySessionEvents(sessionPath: string): Promise<FactoryStoredEventWithSource[]> {
  const events: FactoryStoredEventWithSource[] = [];

  for await (const entry of readJsonlLineEntries(sessionPath)) {
    try {
      const event = JSON.parse(entry.line) as FactoryStoredEvent;
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
      events.push({
        event,
        source: {
          ...(event.type === 'session_start' && event.id ? { entryId: event.id } : {}),
          lineNumber: entry.lineNumber,
          byteOffset: entry.byteOffset,
        },
      });
    } catch {
      logger.warn(`factory: skipping invalid JSONL line in ${sessionPath}: ${entry.line.slice(0, 120)}`);
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
      part.type === 'text' && typeof part.text === 'string')
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
): void {
  messages.push(...attachNativeSourceToMessages(nextMessages, source));
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

    if (role === 'user') {
      for (const part of content) {
        if (part.type !== 'tool_result') continue;
        const toolUseId = (part as FactoryToolResultPart).tool_use_id || (part as FactoryToolResultPart).toolUseID || '';
        const rawValue = (part as FactoryToolResultPart).value ?? (part as FactoryToolResultPart).content;
        pushMessages(messages, source, [
          new ToolResultMessage(
            timestamp,
            toolUseId,
            normalizeToolResultContent(rawValue),
            Boolean((part as FactoryToolResultPart).is_error),
          ),
        ]);
      }

      const text = getVisibleUserTextParts(content).join('\n');
      if (text) {
        pushMessages(messages, source, [
          new UserMessage(timestamp, stripResolvedFileMentionContext(text)),
        ]);
      }
      continue;
    }

    if (role === 'assistant') {
      for (const part of content) {
        if (part.type === 'thinking' && typeof (part as FactoryTextPart).thinking === 'string') {
          pushMessages(messages, source, [
            new ThinkingMessage(timestamp, (part as FactoryTextPart).thinking!),
          ]);
        } else if (part.type === 'text' && typeof (part as FactoryTextPart).text === 'string') {
          pushMessages(messages, source, convertFactoryAssistantText(timestamp, (part as FactoryTextPart).text!));
        } else if (part.type === 'tool_use') {
          pushMessages(messages, source, [
            convertFactoryToolUse(timestamp, part as FactoryToolUsePart),
          ]);
        }
      }
    }
  }

  return messages;
}

export async function loadFactoryChatMessages(sessionPath: string): Promise<ChatMessage[]> {
  try {
    const events = await readFactorySessionEvents(sessionPath);
    return loadFactoryChatMessagesFromEvents(events);
  } catch (error) {
    logger.warn(`factory: error loading chat messages from ${sessionPath}:`, error);
    return [];
  }
}

export async function loadFactoryChatMessagesBySessionId(sessionId: string): Promise<ChatMessage[]> {
  const sessionPath = await findFactorySessionFileBySessionId(sessionId);
  if (!sessionPath) return [];
  return loadFactoryChatMessages(sessionPath);
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
): Promise<FactoryPreview | null> {
  if (!sessionPath) return null;

  try {
    const events = await readFactorySessionEvents(sessionPath);
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
    logger.warn(`factory: preview fetch failed for ${sessionPath}:`, error);
    return Object.keys(fallback).length > 0 ? buildFallbackPreview(fallback) : null;
  }
}

export async function getFactoryPreviewFromSessionId(sessionId: string): Promise<FactoryPreview | null> {
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

  return getFactoryPreviewFromSessionPath(sessionPath, fallback);
}
