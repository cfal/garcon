// Shared loader for persisted OpenAI-compatible chat providers.

import { promises as fs } from 'fs';
import { AssistantMessage, UserMessage, type ChatMessage } from '../../../common/chat-types.js';

interface StoredMessage {
  content?: string;
  role?: string;
  timestamp?: string;
}

interface LoaderConfig {
  getSessionFilePath: (sessionId: string) => string;
  isValidSessionId: (sessionId: string) => boolean;
  sessionLabel: string;
}

export async function loadOpenAiCompatibleChatMessages(
  sessionId: string | null | undefined,
  config: LoaderConfig,
): Promise<ChatMessage[]> {
  if (!sessionId || !config.isValidSessionId(sessionId)) return [];

  let raw = '';
  try {
    raw = await fs.readFile(config.getSessionFilePath(sessionId), 'utf8');
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as StoredMessage;
      const timestamp = entry.timestamp || new Date().toISOString();
      const content = entry.content || '';
      if (entry.role === 'user' && content) {
        messages.push(new UserMessage(timestamp, content));
      } else if (entry.role === 'assistant' && content) {
        messages.push(new AssistantMessage(timestamp, content));
      }
    } catch {
      // Skips malformed lines.
    }
  }

  return messages;
}

export async function getOpenAiCompatiblePreviewFromSessionId(
  sessionId: string | null | undefined,
  loadMessages: (sessionId: string | null | undefined) => Promise<ChatMessage[]>,
  sessionLabel: string,
): Promise<{
  createdAt: string | null;
  firstMessage: string;
  lastActivity: string | null;
  lastMessage: string;
} | null> {
  if (!sessionId) return null;

  const messages = await loadMessages(sessionId);
  if (messages.length === 0) return null;

  const firstUser = messages.find((msg) => msg.type === 'user-message');
  const lastMsg = [...messages].reverse().find(
    (msg) => msg.type === 'assistant-message' || msg.type === 'user-message',
  );
  const lastTimestamp = [...messages].reverse().find((msg) => msg.timestamp)?.timestamp ?? null;

  return {
    createdAt: messages[0]?.timestamp ?? null,
    firstMessage: firstUser?.type === 'user-message' ? firstUser.content : sessionLabel,
    lastActivity: lastTimestamp,
    lastMessage: lastMsg && 'content' in lastMsg ? lastMsg.content : sessionLabel,
  };
}
