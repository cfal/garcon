import { promises as fs } from 'fs';
import type { ChatMessage } from '../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../chats/search/source-types.js';

export async function loadDetachedSearchMessages(
  source: DetachedTranscriptSource,
): Promise<ChatMessage[]> {
  switch (source.kind) {
    case 'claude-jsonl': {
      const { loadClaudeChatMessages } = await import('./claude/history-loader.js');
      return loadClaudeChatMessages(source.nativePath);
    }
    case 'codex-jsonl': {
      const { loadCodexChatMessages } = await import('./codex/history-loader.js');
      return loadCodexChatMessages(source.nativePath);
    }
    case 'cursor-acp': {
      const { loadCursorChatMessagesBySessionId } = await import('./cursor/history-loader.js');
      return loadCursorChatMessagesBySessionId(source.sessionId, source.projectPath);
    }
    case 'direct-jsonl': {
      const raw = await fs.readFile(source.nativePath, 'utf8');
      const { AssistantMessage, UserMessage } = await import('../../common/chat-types.js');
      const { stripResolvedFileMentionContext } = await import('./shared/file-mention-context.js');
      const messages: ChatMessage[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { role?: unknown; content?: unknown; timestamp?: unknown };
          if (typeof entry.content !== 'string') continue;
          const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : new Date(0).toISOString();
          if (entry.role === 'user') {
            messages.push(new UserMessage(timestamp, stripResolvedFileMentionContext(entry.content)));
          }
          if (entry.role === 'assistant') messages.push(new AssistantMessage(timestamp, entry.content));
        } catch {
          // Malformed persisted lines are ignored consistently with the display loader.
        }
      }
      return messages;
    }
    case 'factory-jsonl': {
      const { loadFactoryChatMessages } = await import('./factory/history-loader.js');
      return loadFactoryChatMessages(source.nativePath);
    }
    case 'opencode-api': {
      const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
      const { loadOpenCodeChatMessages } = await import('./opencode/history-loader.js');
      const client = createOpencodeClient({ baseUrl: source.baseUrl });
      return loadOpenCodeChatMessages(source.sessionId, async () => client, {
        directory: source.directory,
      });
    }
    case 'pi-jsonl': {
      const { loadPiChatMessages } = await import('./pi/history-loader.js');
      return loadPiChatMessages(source.nativePath);
    }
  }
}

