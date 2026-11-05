import type { ChatMessage } from '$shared/chat-types';
import type { LocalNoticeRow } from './local-notice.js';

export interface ChatTranscriptRow {
	kind: 'message';
	id: string;
	message: ChatMessage;
	ordinal?: number;
	awaitingDelivery?: boolean;
}

export type ChatDisplayRow = ChatTranscriptRow | LocalNoticeRow;
