import {
  AssistantMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  type AgentHistoryImport,
  type AgentNativeSessionAccess,
} from '@garcon/server-agent-interface';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.js';
import {
  DirectSessionStore,
  type DirectSessionRecordV1,
} from './session-store.js';

const IMPORT_BATCH_SIZE = 256;
const TRANSCRIPT_UNAVAILABLE_MESSAGE =
  'This conversation cannot be loaded because its Direct history is unavailable.';

export function createDirectNativeSessionAccess(
  sessions: DirectSessionStore,
): AgentNativeSessionAccess {
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      if (!chat.agentSessionId && !chat.nativeSession) return null;
      const sessionId = requiredSessionId(sessions, chat.agentSessionId, chat.nativeSession);
      await loadRequired(sessions, sessionId, signal);
      return sessions.nativeReference(sessionId);
    },

    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      if (!chat.agentSessionId && !chat.nativeSession) return null;
      const sessionId = requiredSessionId(sessions, chat.agentSessionId, chat.nativeSession);
      const snapshot = await loadRequired(sessions, sessionId, signal);
      return { kind: 'filesystem-path', value: snapshot.path };
    },

    async release({ chat, signal }) {
      signal.throwIfAborted();
      if (!chat.nativeSession) return;
      const sessionId = requiredSessionId(sessions, chat.agentSessionId, chat.nativeSession);
      try {
        await sessions.delete(sessionId);
      } catch (error) {
        throw directSessionUnavailable(error);
      }
      signal.throwIfAborted();
    },
  };
}

export function createDirectNativeHistoryImport(
  sessions: DirectSessionStore,
): AgentHistoryImport {
  return {
    async *load({ chat, signal }) {
      signal.throwIfAborted();
      const sessionId = requiredSessionId(sessions, chat.agentSessionId, chat.nativeSession);
      const snapshot = await loadRequired(sessions, sessionId, signal);
      let batch = [] as Array<{ readonly message: UserMessage | AssistantMessage }>;
      for (const record of snapshot.records) {
        signal.throwIfAborted();
        batch.push({ message: importedMessage(record) });
        if (batch.length < IMPORT_BATCH_SIZE) continue;
        yield batch;
        batch = [];
      }
      if (batch.length > 0) yield batch;
    },
  };
}

export async function loadDirectSessionRequired(
  sessions: DirectSessionStore,
  agentSessionId: string,
  nativeSession: Parameters<DirectSessionStore['sessionIdFromReference']>[0],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let sessionId: string;
  try {
    sessionId = sessions.sessionIdFromReference(nativeSession, agentSessionId);
  } catch (error) {
    throw directSessionUnavailable(error);
  }
  return loadRequired(sessions, sessionId, signal);
}

function requiredSessionId(
  sessions: DirectSessionStore,
  agentSessionId: string | null,
  nativeSession: Parameters<DirectSessionStore['sessionIdFromReference']>[0],
): string {
  if (!agentSessionId || !nativeSession) throw directSessionUnavailable();
  try {
    return sessions.sessionIdFromReference(nativeSession, agentSessionId);
  } catch (error) {
    throw directSessionUnavailable(error);
  }
}

async function loadRequired(
  sessions: DirectSessionStore,
  sessionId: string,
  signal: AbortSignal,
) {
  try {
    const snapshot = await sessions.load(sessionId);
    signal.throwIfAborted();
    return snapshot;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw directSessionUnavailable(error);
  }
}

function importedMessage(record: DirectSessionRecordV1): UserMessage | AssistantMessage {
  if (record.type === 'assistant') {
    return new AssistantMessage(record.at, record.content);
  }
  return new UserMessage(
    record.at,
    stripResolvedFileMentionContext(record.content),
    record.attachments.length > 0
      ? record.attachments.map((attachment) => ({
          data: attachment.data,
          name: attachment.name ?? '',
          mimeType: attachment.mimeType,
        }))
      : undefined,
  );
}

export function directSessionUnavailable(cause?: unknown): AgentIntegrationError {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    TRANSCRIPT_UNAVAILABLE_MESSAGE,
    false,
    cause instanceof Error
      ? { causeName: cause.name, causeCode: nodeErrorCode(cause) }
      : undefined,
  );
}

function nodeErrorCode(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : 'INVALID_HISTORY';
}
