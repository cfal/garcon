import { promises as fs } from 'fs';
import {
  buildSessionContext,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from '@earendil-works/pi-coding-agent';
import {
  type ChatMessage,
} from '@garcon/common/chat-types';
import { findPiSessionFileBySessionId } from './pi-session-paths.js';
import { convertPiMessage } from './message-converter.js';
import type { PiConfig } from '../../config.js';

export interface PiPreview {
  createdAt: string | null;
  firstMessage: string;
  lastActivity: string | null;
  lastMessage: string;
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== 'session';
}

function findHeader(entries: FileEntry[]): SessionHeader | null {
  return entries.find((entry): entry is SessionHeader => entry.type === 'session') ?? null;
}

function assertAcyclicActivePath(entries: SessionEntry[]): void {
  const byId = new Map(entries.flatMap((entry) => (
    typeof entry.id === 'string' && entry.id ? [[entry.id, entry] as const] : []
  )));
  let current = entries.at(-1);
  const visited = new Set<string>();
  while (current && typeof current.id === 'string' && current.id) {
    if (visited.has(current.id)) {
      throw new Error('Pi transcript parent graph contains a cycle');
    }
    visited.add(current.id);
    const parentId = typeof current.parentId === 'string' ? current.parentId : null;
    current = parentId ? byId.get(parentId) : undefined;
  }
}

async function readPiSessionFile(sessionPath: string): Promise<{
  entries: FileEntry[];
  header: SessionHeader | null;
  messages: ChatMessage[];
}> {
  const raw = await fs.readFile(sessionPath, 'utf8');
  const entries = parseSessionEntries(raw);
  const header = findHeader(entries);
  const sessionEntries = entries.filter(isSessionEntry);
  assertAcyclicActivePath(sessionEntries);
  const context = buildSessionContext(sessionEntries);
  const messages = context.messages.flatMap((message) => convertPiMessage(message));
  return { entries, header, messages };
}

export async function loadPiChatMessages(sessionPath: string): Promise<ChatMessage[]> {
  return (await readPiSessionFile(sessionPath)).messages;
}

export async function loadPiChatMessagesBySessionId(
  sessionId: string,
  projectPath: string,
  config: PiConfig,
): Promise<ChatMessage[]> {
  const sessionPath = await findPiSessionFileBySessionId(sessionId, projectPath, config);
  if (!sessionPath) return [];
  return loadPiChatMessages(sessionPath);
}

function getPreviewText(message: ChatMessage): string {
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'thinking':
      return message.content;
    default:
      return '';
  }
}

export function getPiPreview(messages: ChatMessage[], header: SessionHeader | null): PiPreview | null {
  if (!header && messages.length === 0) return null;

  const visibleMessages = messages.filter((message) =>
    message.type === 'user-message' || message.type === 'assistant-message');
  const firstUser = visibleMessages.find((message) => message.type === 'user-message');
  const lastVisible = [...visibleMessages].reverse()[0];
  const lastActivity = [...messages].reverse().find((message) => typeof message.timestamp === 'string');
  const fallbackTitle = 'Unknown Pi Session';

  return {
    createdAt: header?.timestamp ?? null,
    firstMessage: firstUser ? getPreviewText(firstUser) : fallbackTitle,
    lastActivity: lastActivity?.timestamp ?? header?.timestamp ?? null,
    lastMessage: lastVisible ? getPreviewText(lastVisible) : fallbackTitle,
  };
}

export async function getPiPreviewFromSessionPath(sessionPath: string): Promise<PiPreview | null> {
  const { header, messages } = await readPiSessionFile(sessionPath);
  return getPiPreview(messages, header);
}

export async function getPiPreviewFromSessionId(
  sessionId: string,
  projectPath: string,
  config: PiConfig,
): Promise<PiPreview | null> {
  const sessionPath = await findPiSessionFileBySessionId(sessionId, projectPath, config);
  if (!sessionPath) return null;
  return getPiPreviewFromSessionPath(sessionPath);
}
