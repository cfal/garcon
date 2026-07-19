import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentTranscriptSource } from '../legacy/types.js';

export const EMPTY_TRANSCRIPT_SOURCE: AgentTranscriptSource = {
  async loadMessages(): Promise<ChatMessage[]> {
    return [];
  },
  async getPreview(): Promise<unknown> {
    return null;
  },
};
