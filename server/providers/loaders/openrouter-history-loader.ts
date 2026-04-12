// Loads OpenRouter session history from persisted JSONL files.

import { promises as fs } from 'fs';
import { AssistantMessage, UserMessage, type ChatMessage } from '../../../common/chat-types.js';
import { getSessionFilePath, isValidSessionId } from '../openrouter-paths.js';

interface StoredMessage {
  content?: string;
  role?: string;
  timestamp?: string;
}

export async function loadOpenRouterChatMessages(sessionId: string | null | undefined): Promise<ChatMessage[]> {
  if (!sessionId || !isValidSessionId(sessionId)) return [];

  let raw: string;
  try {
    raw = await fs.readFile(getSessionFilePath(sessionId), 'utf8');
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
      // Skip malformed lines.
    }
  }

  return messages;
}

export interface OpenRouterPreview {
  createdAt: string | null;
  firstMessage: string;
  lastActivity: string | null;
  lastMessage: string;
}

export async function getOpenRouterPreviewFromSessionId(sessionId: string | null | undefined): Promise<OpenRouterPreview | null> {
  if (!sessionId) return null;

  const messages = await loadOpenRouterChatMessages(sessionId);
  if (messages.length === 0) return null;

  const firstUser = messages.find((msg) => msg.type === 'user-message');
  const lastMsg = [...messages].reverse().find(
    (msg) => msg.type === 'assistant-message' || msg.type === 'user-message',
  );
  const lastTimestamp = [...messages].reverse().find((msg) => msg.timestamp)?.timestamp ?? null;

  return {
    createdAt: messages[0]?.timestamp ?? null,
    firstMessage: firstUser?.type === 'user-message' ? firstUser.content : 'OpenRouter Session',
    lastActivity: lastTimestamp,
    lastMessage: lastMsg && ('content' in lastMsg) ? (lastMsg as { content: string }).content : 'OpenRouter Session',
  };
}
