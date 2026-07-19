import { promises as fs } from 'node:fs';
import type { ChatMessage } from '@garcon/common/chat-types';
import { getArtificialAgentSessionId } from '../chats/artificial-native-path.js';
import {
  getDirectCompatiblePreviewFromSessionId,
  loadDirectCompatibleChatMessages,
  type DirectCompatiblePreview,
} from './history-loader.js';
import { isSafeDirectPathSegment } from './session-paths.js';

export interface DirectTranscriptReference {
  readonly agentSessionId?: string | null;
  readonly modelEndpointId?: string | null;
  readonly nativePath?: string | null;
}

export interface DirectCompatibleTranscriptReader {
  loadMessages(reference: DirectTranscriptReference): Promise<ChatMessage[]>;
  getPreview(reference: DirectTranscriptReference): Promise<DirectCompatiblePreview | null>;
  resolveNativePath(reference: DirectTranscriptReference): Promise<string | null>;
  release(reference: DirectTranscriptReference): Promise<void>;
}

export interface DirectCompatibleTranscriptSourceConfig {
  readonly agentId: string;
  readonly sessionLabel: string;
  readonly findSessionFilePath: (
    sessionId: string,
    preferredEndpointId?: string | null,
  ) => Promise<string | null>;
}

export function createDirectCompatibleTranscriptSource(
  config: DirectCompatibleTranscriptSourceConfig,
): DirectCompatibleTranscriptReader {
  const sessionIdentity = (reference: DirectTranscriptReference) => ({
    endpointId: safeValue(reference.modelEndpointId),
    sessionId: directSessionId(reference, config.agentId),
  });

  const resolve = async (reference: DirectTranscriptReference): Promise<string | null> => {
    const identity = sessionIdentity(reference);
    if (!identity.sessionId) return null;
    return config.findSessionFilePath(identity.sessionId, identity.endpointId);
  };

  const load = async (reference: DirectTranscriptReference) => {
    const identity = sessionIdentity(reference);
    if (!identity.sessionId) return [];
    const nativePath = await resolve(reference);
    if (!nativePath) return [];
    return loadDirectCompatibleChatMessages(identity.sessionId, {
      getSessionFilePath: () => nativePath,
      isValidSessionId: isSafeDirectPathSegment,
      sessionLabel: config.sessionLabel,
    });
  };

  return {
    loadMessages: load,
    async getPreview(reference) {
      const identity = sessionIdentity(reference);
      if (!identity.endpointId || !identity.sessionId) return null;
      return getDirectCompatiblePreviewFromSessionId(
        identity.sessionId,
        () => load(reference),
        config.sessionLabel,
      );
    },
    resolveNativePath: resolve,
    async release(reference) {
      const nativePath = await resolve(reference);
      if (nativePath) await fs.rm(nativePath, { force: true });
    },
  };
}

function directSessionId(
  reference: DirectTranscriptReference,
  agentId: string,
): string | null {
  const directId = safeValue(reference.agentSessionId);
  if (directId) return directId;
  return safeValue(getArtificialAgentSessionId(reference.nativePath, agentId));
}

function safeValue(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return isSafeDirectPathSegment(normalized) ? normalized : null;
}
