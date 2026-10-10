import { parseChatRowContent, parseChatRowTitle } from '../../../common/chat-row-contracts.js';
import type { JsonObject } from '../../../common/json.js';
import type { TranscriptNoticeDetail } from '../../../common/transcript-notice-details.js';

export interface TranscriptNoticeInput {
  readonly title?: string;
  readonly content: string;
  readonly detail?: TranscriptNoticeDetail;
  readonly at?: string;
}

export interface NormalizedTranscriptNotice {
  readonly content: string;
  readonly detail: JsonObject;
  readonly at?: string;
}

export function normalizeNotice(input: TranscriptNoticeInput): NormalizedTranscriptNotice {
  const title = parseChatRowTitle(input.title);
  return {
    content: parseChatRowContent(input.content),
    detail: { ...(input.detail ?? {}), ...(title ? { title } : {}) },
    at: input.at,
  };
}
