import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { convertFactoryToolUse } from './tool-use-converter.js';
import { normalizeToolResultContent } from '../shared/normalize-util.js';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.js';

const FACTORY_HOME = path.join(os.homedir(), '.factory');
const FACTORY_SESSION_DISCOVERY_INDEX = path.join(FACTORY_HOME, 'cache', 'session-discovery-index.json');
const FACTORY_SESSIONS_ROOT = path.join(FACTORY_HOME, 'sessions');

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

interface FactoryStoredChatMessage {
  content?: Array<FactoryTextPart | FactoryToolUsePart | FactoryToolResultPart>;
  role?: string;
}

interface FactoryStoredMessageEvent {
  message?: FactoryStoredChatMessage;
  timestamp?: string;
  type: 'message';
}

type FactoryStoredEvent = FactorySessionStartEvent | FactoryStoredMessageEvent;

export interface FactoryPreview {
  createdAt: string | null;
  firstMessage: string;
  lastActivity: string | null;
  lastMessage: string;
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
    const raw = await fs.readFile(FACTORY_SESSION_DISCOVERY_INDEX, 'utf8');
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
      // Fall through to direct scan.
    }
  }

  return findFileWithSuffix(FACTORY_SESSIONS_ROOT, `${sessionId}.jsonl`);
}

async function readFactorySessionEvents(sessionPath: string): Promise<FactoryStoredEvent[]> {
  const raw = await fs.readFile(sessionPath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FactoryStoredEvent);
}

function getTextParts(content: Array<FactoryTextPart | FactoryToolUsePart | FactoryToolResultPart>): string[] {
  return content
    .filter((part): part is FactoryTextPart & { text: string } =>
      part.type === 'text' && 'text' in part && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean);
}

function getMessageTimestamp(event: FactoryStoredMessageEvent): string {
  return typeof event.timestamp === 'string' && event.timestamp
    ? event.timestamp
    : new Date().toISOString();
}

export function loadFactoryChatMessagesFromEvents(events: FactoryStoredEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const event of events) {
    if (event.type !== 'message' || !event.message) continue;

    const timestamp = getMessageTimestamp(event);
    const role = event.message.role;
    const content = Array.isArray(event.message.content) ? event.message.content : [];

    if (role === 'user') {
      for (const part of content) {
        if (part.type !== 'tool_result') continue;
        const toolUseId = (part as FactoryToolResultPart).tool_use_id || (part as FactoryToolResultPart).toolUseID || '';
        const rawValue = (part as FactoryToolResultPart).value ?? (part as FactoryToolResultPart).content;
        messages.push(new ToolResultMessage(
          timestamp,
          toolUseId,
          normalizeToolResultContent(rawValue),
          Boolean((part as FactoryToolResultPart).is_error),
        ));
      }

      const text = getTextParts(content).join('\n');
      if (text) {
        messages.push(new UserMessage(timestamp, stripResolvedFileMentionContext(text)));
      }
      continue;
    }

    if (role === 'assistant') {
      for (const part of content) {
        if (part.type === 'thinking' && typeof (part as FactoryTextPart).thinking === 'string') {
          messages.push(new ThinkingMessage(timestamp, (part as FactoryTextPart).thinking!));
        } else if (part.type === 'text' && typeof (part as FactoryTextPart).text === 'string' && (part as FactoryTextPart).text?.trim()) {
          messages.push(new AssistantMessage(timestamp, (part as FactoryTextPart).text!));
        } else if (part.type === 'tool_use') {
          messages.push(convertFactoryToolUse(timestamp, part as FactoryToolUsePart));
        }
      }
    }
  }

  return messages;
}

export async function loadFactoryChatMessages(sessionPath: string): Promise<ChatMessage[]> {
  const events = await readFactorySessionEvents(sessionPath);
  return loadFactoryChatMessagesFromEvents(events);
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

export async function getFactoryPreviewFromSessionId(sessionId: string): Promise<FactoryPreview | null> {
  if (!sessionId) return null;

  const [discoveryEntry, sessionPath] = await Promise.all([
    getFactorySessionDiscoveryEntry(sessionId),
    findFactorySessionFileBySessionId(sessionId),
  ]);

  if (!sessionPath && !discoveryEntry) return null;

  const fallbackCreatedAt = toIsoString(discoveryEntry?.createdTimeMs);
  const fallbackLastActivity = toIsoString(discoveryEntry?.modifiedTimeMs);
  const fallbackTitle = discoveryEntry?.sessionTitle || discoveryEntry?.title || 'Unknown Factory Session';

  if (!sessionPath) {
    return {
      createdAt: fallbackCreatedAt,
      firstMessage: fallbackTitle,
      lastActivity: fallbackLastActivity,
      lastMessage: fallbackTitle,
    };
  }

  const [events, messages] = await Promise.all([
    readFactorySessionEvents(sessionPath),
    loadFactoryChatMessages(sessionPath),
  ]);
  const sessionStart = events.find((event): event is FactorySessionStartEvent => event.type === 'session_start');
  const visibleMessages = messages.filter((message) => message.type === 'assistant-message' || message.type === 'user-message');
  const firstMessage = visibleMessages.find((message) => message.type === 'user-message');
  const lastMessage = [...visibleMessages].reverse().find((message) => message.type === 'assistant-message' || message.type === 'user-message');
  const lastActivity = [...messages].reverse().find((message) => typeof message.timestamp === 'string');

  return {
    createdAt: fallbackCreatedAt,
    firstMessage: firstMessage ? firstMessage.content : sessionStart?.sessionTitle || sessionStart?.title || fallbackTitle,
    lastActivity: lastActivity?.timestamp || fallbackLastActivity,
    lastMessage: lastMessage ? getPreviewText(lastMessage) : fallbackTitle,
  };
}
