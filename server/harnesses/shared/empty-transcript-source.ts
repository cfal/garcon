import type { ChatMessage } from '../../../common/chat-types.js';
import type { HarnessTranscriptSource } from '../types.js';

export const EMPTY_TRANSCRIPT_SOURCE: HarnessTranscriptSource = {
  async loadMessages(): Promise<ChatMessage[]> {
    return [];
  },
  async getPreview(): Promise<unknown> {
    return null;
  },
};
