import {
  AssistantMessage,
  UserMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import type {
  AgentHistoryImport,
  AgentHost,
  AgentImportedTranscriptRow,
} from '@garcon/server-agent-interface';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.js';
import { readJsonlLineEntries } from '../shared/history-loader-utils.js';
import { createDirectLegacySessionPaths } from './legacy-session-paths.js';

const IMPORT_BATCH_SIZE = 256;

interface ReleasedDirectMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly timestamp: string;
}

export function createDirectLegacyHistoryImport(
  host: AgentHost,
  storageNamespace: string,
): AgentHistoryImport {
  const sessionPaths = createDirectLegacySessionPaths(
    host.storage.rootDirectory,
    storageNamespace,
  );
  return {
    async *load({ chat, signal }) {
      signal.throwIfAborted();
      if (!chat.agentSessionId) return;
      const sourcePath = await sessionPaths.findSessionFilePath(chat.agentSessionId);
      signal.throwIfAborted();
      if (!sourcePath) return;

      let batch: AgentImportedTranscriptRow[] = [];
      for await (const entry of readJsonlLineEntries(sourcePath, { signal })) {
        const stored = parseReleasedDirectMessage(entry.line);
        batch.push({ message: toChatMessage(stored) });
        if (batch.length < IMPORT_BATCH_SIZE) continue;
        yield batch;
        batch = [];
      }
      if (batch.length > 0) yield batch;
    },
  };
}

function parseReleasedDirectMessage(line: string): ReleasedDirectMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Direct legacy transcript record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.role !== 'user' && record.role !== 'assistant') {
    throw new Error('Direct legacy transcript record has an invalid role');
  }
  if (typeof record.content !== 'string') {
    throw new Error('Direct legacy transcript record has invalid content');
  }
  if (
    typeof record.timestamp !== 'string'
    || !record.timestamp
    || Number.isNaN(new Date(record.timestamp).getTime())
  ) {
    throw new Error('Direct legacy transcript record has an invalid timestamp');
  }
  return {
    role: record.role,
    content: record.content,
    timestamp: record.timestamp,
  };
}

function toChatMessage(stored: ReleasedDirectMessage): ChatMessage {
  if (stored.role === 'user') {
    return new UserMessage(
      stored.timestamp,
      stripResolvedFileMentionContext(stored.content),
    );
  }
  return new AssistantMessage(stored.timestamp, stored.content);
}
