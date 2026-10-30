import {
  parseChatTranscriptActivity,
  type ChatTranscriptActivity,
} from './chat-transcript-activity';
import { isRecord } from './json';

// Body-free counterpart of ChatMessagesMessage. A socket receives the body for
// a committed span only while its declared transcript interest includes the
// chat, and this summary of the same span otherwise. The span names exactly
// the rows the socket did not receive, so a socket that displays the chat
// treats a summary as a gap.
export class ChatTranscriptAdvancedMessage {
  readonly type = 'chat-transcript-advanced' as const;
  constructor(
    public chatId: string,
    public transcriptViewId: string,
    public firstOrdinal: number,
    public lastOrdinal: number,
    public activity: ChatTranscriptActivity,
  ) {}
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

function ordinal(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseChatTranscriptAdvancedMessage(
  data: unknown,
): ChatTranscriptAdvancedMessage | null {
  if (!isRecord(data) || data.type !== 'chat-transcript-advanced') return null;
  const chatId = requiredString(data.chatId);
  const transcriptViewId = requiredString(data.transcriptViewId);
  const firstOrdinal = ordinal(data.firstOrdinal);
  const lastOrdinal = ordinal(data.lastOrdinal);
  const activity = parseChatTranscriptActivity(data.activity);
  if (!chatId || !transcriptViewId || firstOrdinal === null || lastOrdinal === null || !activity) {
    return null;
  }
  if (firstOrdinal < 1 || lastOrdinal < firstOrdinal - 1) return null;
  return new ChatTranscriptAdvancedMessage(chatId, transcriptViewId, firstOrdinal, lastOrdinal, activity);
}
