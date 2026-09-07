import type { ChatHistoryState } from '$shared/chat-view';
import * as m from '$lib/paraglide/messages.js';
import type { LocalNoticeRow } from './local-notice.js';

export function displayLocalNotices(
	hasLaterMessages: boolean,
	historyState: ChatHistoryState,
	localNotices: readonly LocalNoticeRow[],
): readonly LocalNoticeRow[] {
	if (hasLaterMessages) return [];
	if (historyState.kind !== 'degraded') return localNotices;
	return [{
		kind: 'local-notice',
		id: 'carryover-history-unavailable',
		noticeType: 'error',
		content: m.chat_history_unavailable(),
		timestamp: '',
	}, ...localNotices];
}
