import type { ChatMessage } from '../../../common/chat-types.js';
import type { AgentTranscriptSource } from '../types.js';

export const EMPTY_TRANSCRIPT_SOURCE: AgentTranscriptSource = {
  async loadMessages(): Promise<ChatMessage[]> {
    return [];
  },
  async getPreview(): Promise<unknown> {
    return null;
  },
};
