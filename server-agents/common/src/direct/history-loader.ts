// Loads persisted direct compatible chat history into shared chat messages.

import { promises as fs } from 'fs';
import { AssistantMessage, UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';

interface StoredMessage {
  clientRequestId?: string;
  content?: string;
  role?: string;
  timestamp?: string;
  turnId?: string;
}

interface LoaderConfig {
  getSessionFilePath: (sessionId: string) => string;
  isValidSessionId: (sessionId: string) => boolean;
  sessionLabel: string;
}

export interface DirectCompatiblePreview {
  readonly createdAt: string | null;
  readonly firstMessage: string;
  readonly lastActivity: string | null;
  readonly lastMessage: string;
}

export async function loadDirectCompatibleChatMessages(
  sessionId: string | null | undefined,
  config: LoaderConfig,
): Promise<ChatMessage[]> {
  if (!sessionId || !config.isValidSessionId(sessionId)) return [];

  return loadDirectCompatibleChatMessagesFromPath(config.getSessionFilePath(sessionId));
}

export async function loadDirectCompatibleChatMessagesFromPath(
  nativePath: string,
): Promise<ChatMessage[]> {

  let raw = '';
  try {
    raw = await fs.readFile(nativePath, 'utf8');
  } catch {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as StoredMessage;
      const timestamp = entry.timestamp || new Date().toISOString();
      const content = entry.content || '';
      const lineNumber = index + 1;
      if (entry.role === 'user' && content) {
        messages.push(attachNativeMessageSource(
          new UserMessage(
            timestamp,
            stripResolvedFileMentionContext(content),
            undefined,
            entry.clientRequestId || entry.turnId
              ? {
                  ...(entry.clientRequestId ? { clientRequestId: entry.clientRequestId } : {}),
                  ...(entry.turnId ? { turnId: entry.turnId } : {}),
                }
              : undefined,
          ),
          { lineNumber },
        ));
      } else if (entry.role === 'assistant' && content) {
        messages.push(attachNativeMessageSource(
          new AssistantMessage(timestamp, content),
          { lineNumber },
        ));
      }
    } catch {
      // Skips malformed persisted lines.
    }
  }

  return messages;
}

export async function getDirectCompatiblePreviewFromSessionId(
  sessionId: string | null | undefined,
  loadMessages: (sessionId: string | null | undefined) => Promise<ChatMessage[]>,
  sessionLabel: string,
): Promise<DirectCompatiblePreview | null> {
  if (!sessionId) return null;

  const messages = await loadMessages(sessionId);
  if (messages.length === 0) return null;

  const firstUser = messages.find((message) => message.type === 'user-message');
  const lastMessage = [...messages].reverse().find(
    (message) => message.type === 'assistant-message' || message.type === 'user-message',
  );
  const lastTimestamp = [...messages].reverse().find((message) => message.timestamp)?.timestamp ?? null;

  return {
    createdAt: messages[0]?.timestamp ?? null,
    firstMessage: firstUser?.type === 'user-message' ? firstUser.content : sessionLabel,
    lastActivity: lastTimestamp,
    lastMessage: lastMessage && 'content' in lastMessage ? lastMessage.content : sessionLabel,
  };
}
