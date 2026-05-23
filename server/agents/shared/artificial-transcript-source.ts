import { createArtificialNativePath } from '../../chats/artificial-native-path.js';
import type { AgentTranscriptSource } from '../types.js';
import { EMPTY_TRANSCRIPT_SOURCE } from './empty-transcript-source.js';

export function createArtificialTranscriptSource(agentId: string): AgentTranscriptSource {
  return {
    ...EMPTY_TRANSCRIPT_SOURCE,
    async resolveNativePath(session) {
      if (!session.agentSessionId) return null;
      return createArtificialNativePath(agentId, session.agentSessionId);
    },
  };
}
