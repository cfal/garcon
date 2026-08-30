import type { ChatOperationalNoticeType } from '$shared/ws-events';

export type LocalNoticeType = ChatOperationalNoticeType | 'progress';

export interface LocalNoticeRow {
	id: string;
	kind: 'local-notice';
	noticeType: LocalNoticeType;
	content: string;
	timestamp: string;
}
